import "server-only";

import { limiters, sleep } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesInsert } from "@/lib/supabase/database.types";

/**
 * Caractéristiques audio via ReccoBeats.
 *
 * Spotify a supprimé `/v1/audio-features` ; ReccoBeats réexpose les mêmes douze
 * descripteurs, avec les mêmes échelles (vérifié sur 100 pistes : les ratios
 * restent dans [0,1], `key` dans 0..11, `mode` dans 0..1, `loudness` négatif en
 * dBFS, `tempo` en BPM). C'est une source ouverte, donc utilisable comme base
 * d'apprentissage : les identifiants Spotify ne servent que de clé de jointure.
 *
 * Relevés empiriques du 2026-07-27, qui dictent tout le code ci-dessous :
 *
 *  - **Lot de 40 maximum.** À 41 identifiants l'API répond 400
 *    (`"size must be between 1 and 40"`). Elle ne tronque jamais en silence :
 *    c'est tout le lot qui est perdu. Le pipeline coûte donc 40 fois moins de
 *    requêtes qu'un appel par piste, à condition de ne jamais dépasser.
 *  - **`id` n'est PAS l'identifiant Spotify** mais un UUID interne ReccoBeats.
 *    L'identifiant Spotify n'apparaît que dans `href`
 *    (`https://open.spotify.com/track/<id spotify>`) : c'est la seule clé de
 *    jointure possible avec `tracks`. Les 100 réponses observées pointaient
 *    toutes vers `open.spotify.com/track/`, mais on parse défensivement.
 *  - **Un identifiant inconnu est simplement absent de `content`** : pas
 *    d'entrée nulle, pas de trou à la bonne position. L'ordre du tableau ne
 *    permet donc aucun alignement positionnel avec la requête.
 *  - **L'API déduplique** : deux fois le même identifiant ne renvoient qu'une
 *    entrée, alors que la limite de 40 compte les identifiants bruts. On
 *    déduplique donc en amont pour ne pas gaspiller de place dans le lot.
 *  - **Aucun rate limit constaté** (25 requêtes en parallèle et 40 requêtes
 *    séquentielles sans pause : 100 % de 200, aucun en-tête de quota). Non
 *    documenté ne veut pas dire inexistant : on passe malgré tout par
 *    `limiters.reccobeats` et on gère le 429.
 *  - **Seul GET fonctionne** : POST sur le même chemin renvoie 401. Pas de
 *    contournement possible de la limite de 40 par un corps de requête.
 *
 * `/v1/track?ids=` (même limite de 40) renvoie titre, artistes, `durationMs`,
 * `isrc` et `availableCountries`. On ne l'utilise pas : ces métadonnées
 * viennent déjà de Spotify, et `isrc` est de toute façon inclus dans la réponse
 * de `/v1/audio-features`.
 */

const API_BASE = "https://api.reccobeats.com/v1";

/** Limite dure de l'API : au-delà, 400 et le lot entier est perdu. */
export const RECCOBEATS_MAX_IDS_PER_REQUEST = 40;

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Plafond d'attente accepté sur un 429, appliqué aussi bien au sommeil de la
 * tentative en cours qu'à la pause posée sur le limiteur : Vercel coupe à 300 s
 * et une fonction qui dort reste facturée. Sans ce plafond, un `Retry-After` de
 * 30 minutes immobiliserait tout le processus dans `acquire()`, qui n'a lui
 * aucun délai maximal.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Attente appliquée à un 429 sans `Retry-After` exploitable. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * Taille des requêtes vers Postgres. PostgREST passe les filtres `in.(...)` dans
 * l'URL : quelques milliers d'identifiants dépasseraient la limite de taille
 * d'en-tête du serveur.
 */
const DB_CHUNK_SIZE = 500;

export type ReccoBeatsFeatures = {
  /** Extrait de `href`, jamais de `id`. Clé de jointure avec `tracks.id`. */
  spotifyTrackId: string;
  /** UUID interne ReccoBeats. Conservé à titre de traçabilité. */
  reccobeatsId: string | null;
  isrc: string | null;
  acousticness: number | null;
  danceability: number | null;
  energy: number | null;
  instrumentalness: number | null;
  liveness: number | null;
  speechiness: number | null;
  valence: number | null;
  loudness: number | null;
  tempo: number | null;
  key: number | null;
  mode: number | null;
};

/**
 * Récupère les caractéristiques audio, en découpant automatiquement en lots de
 * 40. Les identifiants absents de la réponse sont absents de la Map : c'est à
 * l'appelant de traiter la différence avec sa demande.
 *
 * Ne rejette pas : un lot en échec est journalisé et abandonné, les autres
 * aboutissent. Une source d'enrichissement indisponible dégrade le service.
 */
export async function fetchAudioFeatures(
  spotifyTrackIds: string[],
): Promise<Map<string, ReccoBeatsFeatures>> {
  const found = new Map<string, ReccoBeatsFeatures>();

  // Les identifiants sont concaténés avec des virgules : l'un d'eux contenant
  // une virgule décalerait le découpage côté serveur et ferait passer le lot
  // au-dessus de 40, invalidant les 40 pistes d'un coup.
  const ids = [
    ...new Set(spotifyTrackIds.filter((id) => /^[A-Za-z0-9]+$/.test(id))),
  ];

  for (let i = 0; i < ids.length; i += RECCOBEATS_MAX_IDS_PER_REQUEST) {
    const batch = ids.slice(i, i + RECCOBEATS_MAX_IDS_PER_REQUEST);

    let content: unknown[];
    try {
      content = await requestFeatures(batch);
    } catch (error) {
      console.warn(
        `[reccobeats] lot de ${batch.length} pistes abandonné :`,
        error,
      );
      // Le serveur réclame une pause plus longue que ce qu'un job peut absorber
      // : les lots suivants iraient droit dans le même mur, après avoir dormi
      // le plafond entier chacun. On rend ce qui a déjà été récupéré.
      if (error instanceof ReccoBeatsQuotaError) break;
      continue;
    }

    for (const raw of content) {
      const feature = parseFeature(raw);
      if (feature) found.set(feature.spotifyTrackId, feature);
    }
  }

  return found;
}

/**
 * Remplit `track_features` pour les pistes qui n'y sont pas encore.
 *
 * `missing` regroupe tout ce qui n'a pas pu être stocké : pistes absentes de
 * `tracks` (la clé étrangère l'interdit), pistes inconnues de ReccoBeats, et
 * lots dont l'écriture a échoué. Les pistes déjà présentes ne sont ni
 * comptées dans `enriched` ni listées dans `missing` — elles n'ont rien coûté.
 */
export async function enrichTracksWithFeatures(
  spotifyTrackIds: string[],
): Promise<{ enriched: number; missing: string[] }> {
  const requested = [...new Set(spotifyTrackIds.filter((id) => id.length > 0))];
  if (requested.length === 0) return { enriched: 0, missing: [] };

  const supabase = createAdminClient();

  // `track_features.track_id` référence `tracks.id`. Insérer une piste absente
  // du catalogue ferait échouer l'upsert du lot entier, pas seulement la ligne
  // fautive : on écarte ces identifiants avant d'appeler l'API.
  const known = await selectIds(supabase, "tracks", requested);
  const alreadyStored = await selectIds(supabase, "track_features", [...known]);

  const missing = new Set(requested.filter((id) => !known.has(id)));
  const toFetch = [...known].filter((id) => !alreadyStored.has(id));
  if (toFetch.length === 0) return { enriched: 0, missing: [...missing] };

  const features = await fetchAudioFeatures(toFetch);

  // `fetched_at` a bien une valeur par défaut en base, mais elle ne se
  // réapplique pas sur la branche UPDATE d'un upsert : on la pose nous-mêmes
  // pour que la date reflète le dernier rafraîchissement.
  const fetchedAt = new Date().toISOString();
  const rows: TablesInsert<"track_features">[] = [];

  for (const id of toFetch) {
    const feature = features.get(id);
    if (!feature) {
      missing.add(id);
      continue;
    }
    rows.push({
      track_id: id,
      source: "reccobeats",
      fetched_at: fetchedAt,
      acousticness: feature.acousticness,
      danceability: feature.danceability,
      energy: feature.energy,
      instrumentalness: feature.instrumentalness,
      liveness: feature.liveness,
      speechiness: feature.speechiness,
      valence: feature.valence,
      loudness: feature.loudness,
      tempo: feature.tempo,
      key: feature.key,
      mode: feature.mode,
    });
  }

  let enriched = 0;
  for (const chunk of chunked(rows, DB_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("track_features")
      .upsert(chunk, { onConflict: "track_id" });

    if (error) {
      // Contrairement aux lectures, on ne remonte pas : les autres lots restent
      // valides et les pistes perdues seront reprises au prochain passage.
      console.warn(
        `[reccobeats] écriture de ${chunk.length} lignes échouée :`,
        error.message,
      );
      for (const row of chunk) missing.add(row.track_id);
      continue;
    }
    enriched += chunk.length;
  }

  return { enriched, missing: [...missing] };
}

/** 429 dont le délai réclamé dépasse ce qu'un job peut absorber. */
class ReccoBeatsQuotaError extends Error {
  constructor(retryAfterMs: number) {
    super(`ReccoBeats : quota dépassé, pause demandée de ${retryAfterMs} ms`);
    this.name = "ReccoBeatsQuotaError";
  }
}

async function requestFeatures(ids: string[]): Promise<unknown[]> {
  const url = `${API_BASE}/audio-features?ids=${ids.join(",")}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiters.reccobeats.acquire();

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        // Sans délai maximal, une connexion qui reste ouverte immobiliserait le
        // limiteur — qui est sériel — et donc tout le pipeline.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // Le corps est lu ici, sous le même `signal` et le même filet de
      // rattrapage que l'envoi : une lecture interrompue doit être une
      // tentative ratée, pas une exception qui traverse la boucle de reprise.
      // Le lire systématiquement libère aussi la connexion sur les branches
      // 429 et 5xx, qui n'en font rien.
      text = await response.text();
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(2 ** attempt * 500);
      continue;
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Un HTML d'erreur renvoyé en 200 par un proxy intermédiaire vaut un
        // échec transitoire, pas une réponse vide.
        if (attempt === MAX_RETRIES) {
          throw new Error("ReccoBeats : réponse illisible");
        }
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (typeof body !== "object" || body === null) return [];
      const { content } = body as { content?: unknown };
      return Array.isArray(content) ? content : [];
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      // La pause est plafonnée : `acquire()` n'a pas de délai maximal, une
      // valeur brute de plusieurs minutes bloquerait tout appelant suivant du
      // limiteur, y compris ceux qui n'ont jamais vu le 429.
      limiters.reccobeats.pauseFor(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
      if (retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw new ReccoBeatsQuotaError(retryAfterMs);
      }
      if (attempt === MAX_RETRIES) {
        throw new Error(`ReccoBeats : quota dépassé (${retryAfterMs} ms)`);
      }
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(2 ** attempt * 500);
      continue;
    }

    throw new Error(
      `ReccoBeats ${response.status} sur /audio-features : ${text.slice(0, 200)}`,
    );
  }

  throw new Error("ReccoBeats : nombre maximal de tentatives atteint");
}

/**
 * ReccoBeats n'ayant jamais renvoyé de 429 lors des mesures, le format de son
 * `Retry-After` est inconnu : on suppose la forme en secondes de la RFC et on
 * retombe sur une attente forfaitaire dans tous les autres cas.
 */
function parseRetryAfter(header: string | null): number {
  // `Number(null)` et `Number("")` valent 0 : sans ce garde, un 429 dépourvu
  // d'en-tête — le cas le plus probable — donnerait 1 s au lieu du forfait.
  const trimmed = header?.trim();
  if (!trimmed) return DEFAULT_RETRY_AFTER_MS;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(seconds, 1) * 1000;
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function parseFeature(raw: unknown): ReccoBeatsFeatures | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  const spotifyTrackId = spotifyIdFromHref(entry.href);
  if (!spotifyTrackId) return null;

  return {
    spotifyTrackId,
    reccobeatsId: typeof entry.id === "string" ? entry.id : null,
    isrc: typeof entry.isrc === "string" ? entry.isrc : null,
    acousticness: toRatio(entry.acousticness),
    danceability: toRatio(entry.danceability),
    energy: toRatio(entry.energy),
    instrumentalness: toRatio(entry.instrumentalness),
    liveness: toRatio(entry.liveness),
    speechiness: toRatio(entry.speechiness),
    valence: toRatio(entry.valence),
    loudness: toFiniteNumber(entry.loudness),
    tempo: toFiniteNumber(entry.tempo),
    // `key` et `mode` alimentent des colonnes smallint : un flottant y
    // provoquerait une erreur d'insertion sur tout le lot.
    key: toSmallInt(entry.key, 0, 11),
    mode: toSmallInt(entry.mode, 0, 1),
  };
}

/**
 * `id` étant l'identifiant interne ReccoBeats, la jointure avec notre catalogue
 * passe obligatoirement par `href` : `https://open.spotify.com/track/<id>`.
 */
function spotifyIdFromHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  return /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(href)?.[1] ?? null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Écarte les valeurs hors [0,1], que le moteur de scoring suppose normalisées. */
function toRatio(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function toSmallInt(value: unknown, min: number, max: number): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  return rounded >= min && rounded <= max ? rounded : null;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Identifiants effectivement présents dans la table, par requêtes découpées.
 * `tracks` et `track_features` nomment leur clé différemment, d'où la
 * distinction — les deux renvoient bien des identifiants de piste.
 */
async function selectIds(
  supabase: AdminClient,
  table: "tracks" | "track_features",
  ids: string[],
): Promise<Set<string>> {
  const present = new Set<string>();

  for (const chunk of chunked(ids, DB_CHUNK_SIZE)) {
    const { data, error } =
      table === "tracks"
        ? await supabase.from("tracks").select("id").in("id", chunk)
        : await supabase
            .from("track_features")
            .select("track_id")
            .in("track_id", chunk);

    // Une base injoignable n'est pas une dégradation rattrapable : sans elle on
    // ne sait ni quoi récupérer, ni où l'écrire.
    if (error) {
      throw new Error(`Lecture de ${table} impossible : ${error.message}`);
    }

    for (const row of data ?? []) {
      present.add("id" in row ? row.id : row.track_id);
    }
  }

  return present;
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
