import "server-only";

import { env } from "@/lib/env";
import { limiters, sleep } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Résolution d'identité et genres via MusicBrainz.
 *
 * C'est la porte de sortie de l'écosystème Spotify : l'ISRC d'un morceau — un
 * identifiant de l'industrie, pas une donnée Spotify — se résout en MBID, qui
 * ouvre ensuite l'accès à ListenBrainz. Les genres récoltés ici viennent d'une
 * base ouverte et sont donc, contrairement aux `spotify_genres`, exploitables
 * pour entraîner le moteur.
 *
 * Le coût est de deux requêtes par morceau à 1 req/s (voir `fetchRecordingGenres`),
 * ce qui fait de ce module le goulot d'étranglement de tout l'enrichissement.
 *
 * ---
 * Pourquoi on ne résout pas les artistes par leur nom.
 *
 * `/ws/2/artist?query=` existe mais n'est pas fiable pour remplir
 * `artists.mb_artist_mbid` : c'est une recherche plein texte, pas une
 * résolution. Mesuré sur des noms courants, plusieurs homonymes exacts
 * reviennent avec des scores voisins — « Nirvana » donne 41 résultats dont
 * quatre groupes portant exactement ce nom (US 100, UK 75, FR 61, FI 60), et
 * « Eden » en donne 565 avec trois correspondances exactes à 100, 95 et 92. Le
 * score ne mesure que la proximité de la chaîne : rien ne distingue le bon
 * artiste, et une erreur ici contaminerait durablement le profil de goût.
 *
 * La voie sûre passe par l'enregistrement : `inc=artist-credits` est accepté
 * sur la ressource `isrc` (vérifié) et renvoie directement le MBID de
 * l'artiste, sans ambiguïté puisqu'il vient du morceau lui-même. C'est ce
 * chemin qu'il faudra emprunter le jour où `mb_artist_mbid` sera renseigné.
 */

const WS_BASE = "https://musicbrainz.org/ws/2";

/** Valeur de `tags.source` pour tout ce qui est écrit ici. */
const TAG_SOURCE = "musicbrainz";

const MAX_RETRIES = 3;

/**
 * Au-delà de cette attente, on rend la main plutôt que de dormir : une fonction
 * Vercel est coupée à 300 s et facturée pendant qu'elle attend.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Sans échéance, une connexion qui reste ouverte sans répondre bloque le job
 * jusqu'à la coupure de la plateforme, et tout le lot est perdu. `fetch`
 * n'impose aucun délai par défaut.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Marge de sécurité sur le budget de requêtes annoncé par MusicBrainz. En
 * dessous, on se met en pause au lieu d'aller chercher le mur.
 */
const RATE_LIMIT_FLOOR = 20;

/**
 * Délai avant de retenter un morceau dont l'ISRC n'a rien donné. Un ISRC absent
 * de MusicBrainz peut y être ajouté plus tard, mais rarement d'une semaine sur
 * l'autre : réessayer plus souvent gaspillerait le quota.
 */
const RETRY_UNRESOLVED_DAYS = 30;

/**
 * Budgets par défaut d'une exécution. À 2 requêtes par morceau et 1,1 s entre
 * chacune, un morceau coûte ~2,2 s : 240 s permettent d'en traiter une centaine,
 * ce qui laisse de la marge sous la limite de 300 s des fonctions.
 */
const DEFAULT_MAX_TRACKS = 100;
const DEFAULT_DEADLINE_MS = 240_000;

/** Taille des lots de lecture, pour ne pas fabriquer une URL PostgREST géante. */
const SELECT_CHUNK = 200;

type MbRecording = {
  id: string;
  title: string;
  "first-release-date"?: string;
};

type MbIsrcLookup = {
  isrc: string;
  recordings?: MbRecording[];
};

type MbGenre = {
  name: string;
  count: number;
};

type MbRecordingLookup = {
  id: string;
  genres?: MbGenre[];
};

/** Genre MusicBrainz normalisé, tel que renvoyé par `fetchRecordingGenres`. */
export type RecordingGenre = {
  name: string;
  count: number;
};

/**
 * L'information n'est pas absente, elle est momentanément inaccessible.
 *
 * La distinction est structurante : un 404 signifie « cet ISRC n'existe pas
 * chez MusicBrainz » et doit être mémorisé, tandis qu'un throttling ne dit rien
 * du morceau et ne doit surtout pas être enregistré comme un échec définitif.
 */
class MusicBrainzUnavailable extends Error {
  constructor(message: string) {
    super(`MusicBrainz indisponible : ${message}`);
    this.name = "MusicBrainzUnavailable";
  }
}

/**
 * Appelle le web service MusicBrainz.
 *
 * Renvoie `null` sur 404 (ressource inconnue) et lève `MusicBrainzUnavailable`
 * quand l'échec est transitoire, pour que l'appelant puisse traiter les deux
 * cas différemment.
 */
async function mbFetch<T>(path: string): Promise<T | null> {
  const url = `${WS_BASE}${path}`;
  const userAgent = env().MUSICBRAINZ_USER_AGENT;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiters.musicbrainz.acquire();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          // Sans User-Agent identifiant, MusicBrainz répond 403 avec un message
          // explicite sur les applications non identifiées. Vérifié.
          "User-Agent": userAgent,
          Accept: "application/json",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      if (attempt === MAX_RETRIES) {
        throw new MusicBrainzUnavailable(
          cause instanceof Error ? cause.message : "erreur réseau",
        );
      }
      await sleep(2 ** attempt * 500);
      continue;
    }

    if (response.status === 404) return null;

    if (response.ok) {
      applyRateLimitHeaders(response);
      try {
        return (await response.json()) as T;
      } catch {
        throw new MusicBrainzUnavailable("réponse JSON illisible");
      }
    }

    // Contre-intuitif, mais vérifié en saturant volontairement le quota :
    // MusicBrainz signale le dépassement par un **503 assorti de Retry-After**,
    // jamais par un 429. Un 503 est donc presque toujours un throttling et non
    // une panne — le retenter est la bonne réaction, et la pause doit valoir
    // pour tous les appels du processus, pas seulement pour celui-ci.
    if (response.status === 503 || response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      limiters.musicbrainz.pauseFor(retryAfterMs);

      if (retryAfterMs > MAX_RETRY_AFTER_MS || attempt === MAX_RETRIES) {
        throw new MusicBrainzUnavailable(`quota dépassé (${response.status})`);
      }
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(2 ** attempt * 500);
      continue;
    }

    // 400 (paramètre `inc` invalide) ou 403 (User-Agent refusé) : réessayer n'y
    // changerait rien, c'est un défaut de la requête elle-même.
    throw new MusicBrainzUnavailable(
      `HTTP ${response.status} sur ${path.split("?")[0]}`,
    );
  }

  throw new MusicBrainzUnavailable("nombre maximal de tentatives atteint");
}

/**
 * MusicBrainz publie un budget résiduel sur une fenêtre glissante partagée par
 * adresse IP. Observé : le compteur chute de bien plus d'une unité par requête
 * (~85), et son passage à zéro déclenche des 503 en rafale. On s'arrête donc
 * avant la butée plutôt que d'attendre d'être refusé.
 */
function applyRateLimitHeaders(response: Response): void {
  // `Number(null)` vaut 0, pas NaN : lire l'en-tête sans vérifier sa présence
  // ferait passer une réponse dépourvue de quota pour un quota épuisé.
  const remainingHeader = response.headers.get("X-RateLimit-Remaining");
  if (remainingHeader === null) return;

  const remaining = Number(remainingHeader);
  if (!Number.isFinite(remaining) || remaining > RATE_LIMIT_FLOOR) return;

  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const resetEpoch = resetHeader === null ? NaN : Number(resetHeader);
  const waitMs = Number.isFinite(resetEpoch)
    ? resetEpoch * 1000 - Date.now()
    : 1_000;

  if (waitMs > 0) {
    limiters.musicbrainz.pauseFor(Math.min(waitMs, MAX_RETRY_AFTER_MS));
  }
}

function parseRetryAfter(header: string | null): number {
  // `Number(null)` et `Number("")` valent 0 : sans ce test, un 503 dépourvu de
  // `Retry-After` retomberait sur le plancher d'une seconde au lieu du repli
  // prudent, et repartirait aussitôt dans le mur.
  if (header === null || header.trim() === "") return 5_000;

  const seconds = Number(header);
  // Observé pendant la saturation : MusicBrainz renvoie parfois `Retry-After: 0`,
  // qui relancerait la requête immédiatement dans le mur. D'où le plancher.
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(seconds, 1) * 1000;
  }
  return 5_000;
}

/**
 * Un ISRC fait 12 caractères : 2 lettres de pays, 3 alphanumériques de
 * déclarant, 2 chiffres d'année, 5 de référence. Filtrer en amont évite de
 * dépenser une seconde de quota sur une valeur qui ne peut que produire un 404.
 */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Un ISRC désigne en principe un enregistrement unique, et c'est ce qu'on
 * observe (18 ISRC testés, 18 réponses à un seul élément). Le schéma autorise
 * pourtant une liste : un label peut réutiliser un ISRC sur un remaster. On
 * tranche alors sur la date de première parution — l'enregistrement d'origine
 * est le mieux documenté — et l'ordre reste total pour que deux exécutions
 * aboutissent au même MBID.
 */
function pickCanonicalRecording(recordings: MbRecording[]): MbRecording {
  return [...recordings].sort((a, b) => {
    const dateA = a["first-release-date"] || "9999-99-99";
    const dateB = b["first-release-date"] || "9999-99-99";
    return dateA === dateB ? a.id.localeCompare(b.id) : dateA.localeCompare(dateB);
  })[0];
}

async function lookupIsrc(
  isrc: string,
): Promise<{ mbid: string; title: string } | null> {
  const normalized = isrc.trim().toUpperCase().replace(/-/g, "");
  if (!ISRC_PATTERN.test(normalized)) return null;

  const data = await mbFetch<MbIsrcLookup>(
    `/isrc/${encodeURIComponent(normalized)}?fmt=json`,
  );

  const recordings = data?.recordings ?? [];
  if (recordings.length === 0) return null;

  const recording = pickCanonicalRecording(recordings);
  if (!recording?.id) return null;

  return { mbid: recording.id, title: recording.title ?? "" };
}

/**
 * Résout un ISRC en enregistrement MusicBrainz.
 *
 * Renvoie `null` aussi bien quand l'ISRC est inconnu que quand MusicBrainz est
 * injoignable : les appelants qui doivent distinguer les deux cas passent par
 * `enrichTracksFromMusicBrainz`, qui gère la nuance en interne.
 */
export async function resolveIsrcToRecording(
  isrc: string,
): Promise<{ mbid: string; title: string } | null> {
  try {
    return await lookupIsrc(isrc);
  } catch (error) {
    // On n'absorbe que l'indisponibilité de la source. Un `catch` attrape-tout
    // masquerait les erreurs de configuration — une variable d'environnement
    // manquante ferait silencieusement renvoyer `null` à chaque morceau, et le
    // job semblerait tourner alors qu'il n'appelle jamais MusicBrainz.
    if (error instanceof MusicBrainzUnavailable) return null;
    throw error;
  }
}

async function lookupRecordingGenres(mbid: string): Promise<RecordingGenre[]> {
  const data = await mbFetch<MbRecordingLookup>(
    `/recording/${encodeURIComponent(mbid)}?fmt=json&inc=genres`,
  );
  if (!data?.genres?.length) return [];

  // La casse est déjà minuscule côté MusicBrainz ; on la force malgré tout pour
  // que la clé d'unicité de `tags` ne puisse pas se dédoubler sur une variante.
  const byName = new Map<string, number>();
  for (const genre of data.genres) {
    if (typeof genre?.name !== "string") continue;
    const name = genre.name.trim().toLowerCase();
    // Le compte est un solde de votes : une valeur nulle ou négative signale un
    // genre contesté, qu'on écarte plutôt que de lui donner un poids plancher.
    const count = Number(genre.count);
    if (!name || !Number.isFinite(count) || count <= 0) continue;

    byName.set(name, Math.max(byName.get(name) ?? 0, count));
  }

  return [...byName].map(([name, count]) => ({ name, count }));
}

/**
 * Récupère les genres d'un enregistrement.
 *
 * Cet appel est incompressible : `inc=genres` est refusé sur la ressource
 * `isrc` (« genres is not a valid inc parameter for the isrc resource »), il
 * faut donc une seconde requête sur la ressource `recording`. À noter,
 * `inc=tags` est en revanche accepté sur `isrc` — mais les tags bruts sont une
 * folksonomie non filtrée (« beach », « hanging out », « remark/catchy »)
 * là où `genres` est le vocabulaire contrôlé. On paie la requête supplémentaire
 * pour cette qualité.
 */
export async function fetchRecordingGenres(
  mbid: string,
): Promise<RecordingGenre[]> {
  try {
    return await lookupRecordingGenres(mbid);
  } catch (error) {
    if (error instanceof MusicBrainzUnavailable) return [];
    throw error;
  }
}

/**
 * `count` est le nombre de votes humains reçus par ce genre sur cet
 * enregistrement. C'est un entier non borné dont l'échelle dépend surtout de la
 * notoriété du morceau : « Bohemian Rhapsody » culmine à 13 votes quand un
 * titre confidentiel plafonne à 1. Une normalisation absolue rendrait donc les
 * morceaux incomparables entre eux.
 *
 * On rapporte chaque compte au maximum de l'enregistrement — le genre dominant
 * vaut toujours 1 — puis on applique une racine carrée. Sans elle, un genre à
 * 1 vote sur 13 tomberait à 0,08 et disparaîtrait sous le bruit alors qu'un
 * humain l'a bel et bien affirmé ; la racine le remonte à 0,28 en préservant
 * l'ordre des genres.
 */
function normalizeWeight(count: number, maxCount: number): number {
  if (maxCount <= 0) return 1;
  const ratio = Math.min(count / maxCount, 1);
  return Math.round(Math.sqrt(ratio) * 10_000) / 10_000;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** Écrit les genres d'un morceau. Renvoie `true` si au moins un tag est posé. */
async function writeTrackTags(
  admin: AdminClient,
  trackId: string,
  genres: RecordingGenre[],
): Promise<boolean> {
  if (genres.length === 0) return false;

  const { data: rows, error: tagsError } = await admin
    .from("tags")
    // `ignoreDuplicates: true` produirait un ON CONFLICT DO NOTHING, et
    // PostgREST ne renverrait alors *que* les lignes réellement insérées : les
    // tags déjà connus repartiraient sans identifiant (vérifié, la réponse est
    // un tableau vide au second passage). Il faut donc fusionner pour récupérer
    // l'intégralité des ids.
    .upsert(
      genres.map((genre) => ({ name: genre.name, source: TAG_SOURCE })),
      { onConflict: "name,source", ignoreDuplicates: false },
    )
    .select("id, name");

  if (tagsError) throw new Error(`upsert tags : ${tagsError.message}`);

  const idByName = new Map((rows ?? []).map((row) => [row.name, row.id]));
  const maxCount = Math.max(...genres.map((genre) => genre.count));

  const links = genres.flatMap((genre) => {
    const tagId = idByName.get(genre.name);
    if (tagId === undefined) return [];
    return [
      {
        track_id: trackId,
        tag_id: tagId,
        weight: normalizeWeight(genre.count, maxCount),
      },
    ];
  });

  if (links.length === 0) return false;

  const { error } = await admin
    .from("track_tags")
    .upsert(links, { onConflict: "track_id,tag_id" });

  if (error) throw new Error(`upsert track_tags : ${error.message}`);

  return true;
}

type EnrichOptions = {
  /** Plafond de morceaux traités en une exécution. */
  maxTracks?: number;
  /** Temps maximal consacré au lot, pour rendre la main avant la coupure. */
  deadlineMs?: number;
};

/**
 * Sélectionne les morceaux à traiter parmi `trackIds`.
 *
 * Sont écartés : ceux sans ISRC (rien à interroger), ceux déjà résolus, et ceux
 * dont une tentative récente n'a rien donné — sans ce dernier filtre, un ISRC
 * absent de MusicBrainz serait rejoué à chaque exécution et monopoliserait le
 * quota au détriment des morceaux jamais tentés.
 */
async function selectCandidates(
  admin: AdminClient,
  trackIds: string[],
  maxTracks: number,
): Promise<Array<{ id: string; isrc: string }>> {
  const retryCutoff = new Date(
    Date.now() - RETRY_UNRESOLVED_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const candidates: Array<{ id: string; isrc: string }> = [];

  for (let i = 0; i < trackIds.length && candidates.length < maxTracks; i += SELECT_CHUNK) {
    const chunk = trackIds.slice(i, i + SELECT_CHUNK);

    const { data, error } = await admin
      .from("tracks")
      .select("id, isrc")
      .in("id", chunk)
      .not("isrc", "is", null)
      .is("mb_recording_mbid", null)
      .or(`enriched_at.is.null,enriched_at.lt.${retryCutoff}`)
      .limit(maxTracks - candidates.length);

    if (error) throw new Error(`lecture tracks : ${error.message}`);

    for (const row of data ?? []) {
      if (row.isrc) candidates.push({ id: row.id, isrc: row.isrc });
    }
  }

  return candidates;
}

/**
 * Enrichit un lot de morceaux : ISRC → MBID, puis genres MusicBrainz.
 *
 * Le traitement est volontairement séquentiel — le limiteur sérialise de toute
 * façon les appels à 1 req/s, et paralléliser ne ferait qu'allonger la file.
 * `resolved` compte les morceaux dotés d'un MBID, `tagged` ceux pour lesquels
 * au moins un genre a été écrit ; les deux diffèrent car beaucoup
 * d'enregistrements résolus n'ont aucun genre (`"genres": []` est fréquent).
 */
export async function enrichTracksFromMusicBrainz(
  trackIds: string[],
  options: EnrichOptions = {},
): Promise<{ resolved: number; tagged: number }> {
  const maxTracks = options.maxTracks ?? DEFAULT_MAX_TRACKS;
  const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  let resolved = 0;
  let tagged = 0;

  const unique = [...new Set(trackIds.filter((id) => Boolean(id)))];
  if (unique.length === 0 || maxTracks <= 0) return { resolved, tagged };

  const admin = createAdminClient();
  const candidates = await selectCandidates(admin, unique, maxTracks);

  for (const track of candidates) {
    if (Date.now() > deadline) break;

    let recording: { mbid: string; title: string } | null;
    let genres: RecordingGenre[] = [];

    try {
      recording = await lookupIsrc(track.isrc);
      // Les deux requêtes sont faites avant la moindre écriture. La sélection
      // écarte définitivement les morceaux dont `mb_recording_mbid` est déjà
      // rempli : poser le MBID puis se faire throttler sur la requête de genres
      // priverait ce morceau de ses tags pour toujours, alors que l'échec est
      // transitoire. Regrouper les appels garantit qu'une ligne n'est marquée
      // que lorsque tout ce qu'il y avait à récupérer l'a été.
      if (recording) genres = await lookupRecordingGenres(recording.mbid);
    } catch (error) {
      // MusicBrainz nous throttle ou est en panne : les morceaux suivants
      // échoueraient à l'identique. On rend ce qui a été fait, la prochaine
      // exécution reprendra sur les mêmes candidats. Toute autre erreur est un
      // défaut de code ou de configuration et doit rester visible.
      if (error instanceof MusicBrainzUnavailable) {
        // Sans cette trace, un lot interrompu dès le premier morceau (503, ou
        // User-Agent refusé) renverrait `{0, 0}` — exactement ce que renvoie un
        // lot n'ayant rien à faire.
        console.warn(`[musicbrainz] lot interrompu : ${error.message}`);
        break;
      }
      throw error;
    }

    // Les tags d'abord, la marque ensuite, pour la même raison : `enriched_at`
    // et le MBID signifient « ce morceau est traité », ils ne doivent être posés
    // qu'une fois le reste en base. L'écriture est idempotente, la rejouer au
    // prochain passage ne coûte rien.
    let written = false;
    try {
      written = await writeTrackTags(admin, track.id, genres);
    } catch (error) {
      // Une écriture ratée ne doit pas emporter le lot — mais elle ne doit pas
      // non plus passer inaperçue : sans ce message, une base en panne
      // ressemblerait trait pour trait à « MusicBrainz n'a aucun genre ».
      console.warn(`[musicbrainz] tags de ${track.id} non écrits :`, error);
      continue;
    }

    // `enriched_at` est posé même quand l'ISRC est introuvable : c'est la trace
    // de la tentative, celle qui permet au filtre de ne pas rejouer ce morceau
    // avant plusieurs semaines. Un échec transitoire, lui, sort par le `break`
    // ci-dessus sans jamais toucher à la ligne.
    const { error: updateError } = await admin
      .from("tracks")
      .update({
        mb_recording_mbid: recording?.mbid ?? null,
        enriched_at: new Date().toISOString(),
      })
      .eq("id", track.id);

    if (updateError) throw new Error(`update tracks : ${updateError.message}`);

    if (recording) resolved++;
    if (written) tagged++;
  }

  return { resolved, tagged };
}
