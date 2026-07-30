import "server-only";

import { env } from "@/lib/env";
import { limiters, sleep } from "@/lib/rate-limit";

/**
 * Similarité issue des écoutes réelles de ListenBrainz (MetaBrainz Labs).
 *
 * Ces datasets sont calculés par co-occurrence en session sur des centaines de
 * millions d'écoutes déclarées par les utilisateurs de ListenBrainz. Ils sont
 * publics et sans lien avec Spotify : c'est exactement ce que la Developer
 * Policy impose comme socle d'apprentissage, les identifiants Spotify n'étant
 * qu'une clé de jointure.
 *
 * FRONTIÈRE À RESPECTER — ce module ne parle que MusicBrainz.
 * Entrées et sorties sont des MBID, jamais des identifiants Spotify. Les MBID
 * renvoyés ici sont des *candidats bruts* : il revient à la couche de résolution
 * (recherche par ISRC puis par titre/artiste) de les rattacher à un id Spotify,
 * et d'accepter qu'une partie ne soit pas résolvable. Ne pas court-circuiter
 * cette étape en supposant une correspondance 1:1.
 */

const LABS_BASE = "https://labs.api.listenbrainz.org";

/** 3 tentatives au total ; au-delà, on rend un résultat vide plutôt que d'échouer. */
const MAX_RETRIES = 2;

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Algorithmes acceptés par /similar-recordings, relevés le 2026-07-27 en
 * envoyant une valeur invalide : l'erreur 400 énumère le contenu réel de
 * `AlgorithmEnum`. C'est la seule source fiable, la doc ne les liste pas.
 *
 * Attention, le suffixe n'est PAS uniforme : quatre valeurs s'arrêtent à
 * `_skip_30`, trois ajoutent `_top_n_listeners_1000`. Ne rien reconstruire par
 * concaténation, recopier la constante.
 */
export const SIMILAR_RECORDINGS_ALGORITHMS = [
  "session_based_days_180_session_300_contribution_5_threshold_15_limit_50_skip_30",
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000",
  "session_based_days_7500_session_300_contribution_sqrt_threshold_15_limit_50_skip_30_top_n_listeners_1000",
  "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30",
  "session_based_listens_session_300_contribution_5_threshold_15_limit_50_skip_30",
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30",
  "session_based_days_1500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000",
] as const;

/**
 * Algorithmes acceptés par /similar-artists. Énumération DIFFÉRENTE de celle des
 * recordings : la plupart sont en `threshold_10_limit_100_filter_True_skip_30`.
 *
 * Piège vérifié : passer un algorithme d'artistes à /similar-recordings (ou
 * l'inverse) renvoie 400 « value is not a valid enumeration member ». Seul
 * `session_based_days_9000_..._threshold_15_limit_50_skip_30` figure dans les
 * deux listes ; toutes les autres valeurs sont exclusives à un endpoint.
 */
export const SIMILAR_ARTISTS_ALGORITHMS = [
  "session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30",
  "session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30",
  "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30",
  "session_based_days_75_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30",
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30",
  "session_based_days_1800_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30",
] as const;

export type SimilarRecordingsAlgorithm =
  (typeof SIMILAR_RECORDINGS_ALGORITHMS)[number];
export type SimilarArtistsAlgorithm =
  (typeof SIMILAR_ARTISTS_ALGORITHMS)[number];

/**
 * Fenêtre de ~20 ans, celle qu'emploie ListenBrainz sur son propre site. Les
 * fenêtres courtes (`days_75`, `days_180`) suivent la mode du moment et
 * produisent des scores d'un ordre de grandeur plus faible.
 */
const DEFAULT_RECORDINGS_ALGORITHM: SimilarRecordingsAlgorithm =
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30";

const DEFAULT_ARTISTS_ALGORITHM: SimilarArtistsAlgorithm =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

export type SimilarRecording = {
  mbid: string;
  /**
   * Score de co-occurrence brut : un ENTIER non borné, pas une similarité 0–1.
   * Les ordres de grandeur diffèrent radicalement d'un algorithme à l'autre
   * (54 pour `days_180`, 1159 pour `days_9000` sur un même morceau). Ne jamais
   * comparer ni additionner des scores issus d'algorithmes différents sans les
   * avoir normalisés au préalable.
   */
  score: number;
  name?: string;
  artist?: string;
};

export type SimilarArtist = {
  mbid: string;
  /** Même réserve que pour les recordings : entier brut, échelle dépendante de l'algorithme. */
  score: number;
  name?: string;
  /**
   * Type MusicBrainz de l'entité : « Group », « Person », parfois « Orchestra »,
   * « Choir », « Character »… Exposé parce que la couche de résolution ne peut
   * pas le deviner. Voir la mise en garde sur `fetchSimilarArtists` avant de
   * s'en servir comme filtre.
   */
  type?: string;
};

type RawSimilarRecording = {
  recording_mbid: string | null;
  recording_name: string | null;
  artist_credit_name: string | null;
  score: number | null;
  reference_mbid: string | null;
};

type RawSimilarArtist = {
  artist_mbid: string | null;
  name: string | null;
  type: string | null;
  score: number | null;
  reference_mbid: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Morceaux souvent écoutés dans la même session que `recordingMbid`.
 *
 * Renvoie un tableau vide si le MBID est absent du dataset (cas très fréquent :
 * l'index ne couvre que ce qui a été réellement écouté sur ListenBrainz), s'il
 * est malformé, ou si le service est indisponible. Une source d'enrichissement
 * muette dégrade la reco, elle ne doit pas interrompre le job qui parcourt le
 * catalogue. Seule exception levée : un `algorithm` hors énumération, qui est
 * une faute de programmation et non un aléa (voir `assertAlgorithm`).
 *
 * ATTENTION aux quasi-doublons : MusicBrainz attribue un MBID distinct à chaque
 * enregistrement d'un même titre (version album, single, remaster), et le même
 * titre peut donc revenir plusieurs fois sous des MBID différents — vérifié le
 * 2026-07-27 sur d7500dd6 (« Shape of You », Ed Sheeran) avec `days_9000` :
 * « Let Me Love You » y figure deux fois. Cette forme de doublon-là n'est PAS
 * traitée ici : elle ne se voit qu'après résolution, par ISRC ou par couple
 * titre/artiste. En revanche un même MBID répété à l'identique est écarté
 * (voir `dedupeByMbid`).
 *
 * Le MBID de référence, lui, n'apparaît jamais dans ses propres résultats sur
 * les cas observés ; le filtre d'auto-référence est purement défensif.
 */
export async function fetchSimilarRecordings(
  recordingMbid: string,
  algorithm: string = DEFAULT_RECORDINGS_ALGORITHM,
): Promise<SimilarRecording[]> {
  if (!UUID_RE.test(recordingMbid)) return [];

  assertAlgorithm(
    algorithm,
    SIMILAR_RECORDINGS_ALGORITHMS,
    "similar-recordings",
  );

  const rows = await labsFetch<RawSimilarRecording>("/similar-recordings/json", {
    recording_mbids: recordingMbid,
    algorithm,
  });

  return dedupeByMbid(
    rows.flatMap((row) => {
      const usable = keepUsable(row.recording_mbid, row.score, recordingMbid);
      if (!usable) return [];
      return [
        {
          mbid: usable.mbid,
          score: usable.score,
          name: row.recording_name ?? undefined,
          artist: row.artist_credit_name ?? undefined,
        },
      ];
    }),
  );
}

/**
 * Artistes souvent écoutés dans la même session que `artistMbid`.
 *
 * Mêmes garanties de dégradation que `fetchSimilarRecordings`. Un MBID valide
 * mais qui désigne une autre entité (un recording, par exemple) renvoie
 * simplement un tableau vide, sans erreur HTTP.
 *
 * Le dataset mélange groupes et personnes physiques (`type`), mais NE PAS en
 * faire un filtre : mesuré le 2026-07-27 sur les Red Hot Chili Peppers, quatre
 * algorithmes donnent 9 à 10 `Person` sur 100 voisins, et ce sont David Bowie,
 * Michael Jackson, Prince, Eminem, Bob Dylan, Jimi Hendrix, The Weeknd… tous
 * parfaitement présents sur Spotify, souvent parmi les meilleurs scores.
 * Écarter les `Person` reviendrait à jeter d'excellents candidats. Le champ est
 * exposé pour des cas précis (« Character », par exemple), pas pour trier les
 * personnes physiques.
 */
export async function fetchSimilarArtists(
  artistMbid: string,
  algorithm: string = DEFAULT_ARTISTS_ALGORITHM,
): Promise<SimilarArtist[]> {
  if (!UUID_RE.test(artistMbid)) return [];

  assertAlgorithm(algorithm, SIMILAR_ARTISTS_ALGORITHMS, "similar-artists");

  const rows = await labsFetch<RawSimilarArtist>("/similar-artists/json", {
    artist_mbids: artistMbid,
    algorithm,
  });

  return dedupeByMbid(
    rows.flatMap((row) => {
      const usable = keepUsable(row.artist_mbid, row.score, artistMbid);
      if (!usable) return [];
      return [
        {
          mbid: usable.mbid,
          score: usable.score,
          name: row.name ?? undefined,
          type: row.type ?? undefined,
        },
      ];
    }),
  );
}

/**
 * Un algorithme hors énumération est une faute de programmation, pas un aléa
 * réseau : on lève au lieu de renvoyer un tableau vide. Sinon chaque appel
 * échouerait silencieusement en 400 et le moteur tournerait sans candidats,
 * sans que rien ne le signale.
 */
function assertAlgorithm(
  algorithm: string,
  allowed: readonly string[],
  endpoint: string,
): void {
  if (allowed.includes(algorithm)) return;
  throw new Error(
    `Algorithme « ${algorithm} » inconnu de ${endpoint}. ` +
      `Les énumérations des deux endpoints sont distinctes : utiliser ` +
      `SIMILAR_${endpoint === "similar-artists" ? "ARTISTS" : "RECORDINGS"}_ALGORITHMS.`,
  );
}

/**
 * Écarte les lignes inexploitables.
 *
 * Le dataset contient des entrées dont la résolution des métadonnées a échoué
 * côté MetaBrainz : tous les champs sont `null` sauf `score` et
 * `reference_mbid` (reproduit le 2026-07-27, 1 ligne sur 100, sur d7500dd6 avec
 * `days_9000`). Sans ce filtre, un `mbid` null partirait vers la couche de
 * résolution.
 *
 * On retire aussi le MBID de référence lui-même : jamais vu dans les réponses,
 * mais un auto-candidat passerait tous les filtres en aval.
 */
function keepUsable(
  mbid: string | null,
  score: number | null,
  referenceMbid: string,
): { mbid: string; score: number } | null {
  // Même exigence qu'à l'entrée : ces MBID finissent dans des colonnes `uuid`
  // (tracks.mb_recording_mbid, artists.mb_artist_mbid). Une chaîne qui n'est pas
  // un UUID canonique ferait échouer l'insertion bien plus loin, avec un message
  // sans rapport avec sa provenance.
  if (typeof mbid !== "string" || !UUID_RE.test(mbid)) return null;
  if (mbid.toLowerCase() === referenceMbid.toLowerCase()) return null;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return { mbid, score };
}

/**
 * Un même MBID peut revenir plusieurs fois dans une seule réponse, avec deux
 * scores différents — reproduit le 2026-07-27 sur `days_9000` : 3 doublons sur
 * 100 lignes pour 6fdd95d6, 1 pour d7500dd6 (les autres algorithmes testés n'en
 * produisent pas). Les laisser passer coûterait cher en aval : le candidat
 * serait compté deux fois par le scoring, et un upsert par lot vers
 * `artist_similarity` (clé primaire artist_id, similar_artist_id, source)
 * échouerait en « ON CONFLICT DO UPDATE command cannot affect row a second
 * time » dès que deux lignes visent la même clé.
 *
 * On conserve le meilleur score. `Map` garde la position de la première
 * insertion, donc l'ordre décroissant renvoyé par l'API est préservé.
 */
function dedupeByMbid<T extends { mbid: string; score: number }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = row.mbid.toLowerCase();
    const previous = best.get(key);
    if (!previous || row.score > previous.score) best.set(key, row);
  }
  return [...best.values()];
}

/**
 * Appel générique aux datasets Labs.
 *
 * Ne relaie aucune exception : toute panne se traduit par un tableau vide.
 * Les erreurs 4xx ne sont pas réessayées, elles sont déterministes (MBID absent
 * du dataset, paramètre refusé) et un nouvel essai donnerait le même résultat.
 */
async function labsFetch<T>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = `${LABS_BASE}${path}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await limiters.listenbrainz.acquire();

      const response = await fetch(url, {
        headers: { "User-Agent": userAgent(), Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });

      if (response.status === 429) {
        // Aucun en-tête de quota n'est publié par labs.api : à défaut de
        // Retry-After, on s'impose une pause forfaitaire valable pour tous les
        // appelants du processus.
        const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
        limiters.listenbrainz.pauseFor(retryAfterMs);
        if (attempt === MAX_RETRIES) return [];
        await sleep(retryAfterMs);
        continue;
      }

      if (response.status >= 500) {
        if (attempt === MAX_RETRIES) return [];
        await sleep(2 ** attempt * 500);
        continue;
      }

      // Les 400 renvoient une page HTML d'erreur Flask, pas du JSON : lire le
      // corps ici évite un plantage de `json()` et laisse une trace utile.
      if (!response.ok) {
        console.warn(
          `[listenbrainz] ${path} → HTTP ${response.status} : ${(
            await response.text()
          ).slice(0, 300)}`,
        );
        return [];
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) return [];
      // Le filtre n'est pas cosmétique : sans lui, un `null` dans le tableau
      // ferait lever un TypeError chez l'appelant, hors de ce try/catch, ce qui
      // contredirait la promesse « ce module ne jette jamais sur données
      // distantes ».
      return payload.filter(
        (row): row is T => typeof row === "object" && row !== null,
      );
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.warn(`[listenbrainz] ${path} injoignable :`, error);
        return [];
      }
      await sleep(2 ** attempt * 500);
    }
  }

  return [];
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, 60) * 1000
    : 5_000;
}

/**
 * MetaBrainz exige un User-Agent identifiant l'application. On réutilise celui
 * de MusicBrainz, et on tolère un environnement incomplet : `env()` valide tout
 * le schéma d'un bloc et lèverait pour une variable sans rapport, ce qui ferait
 * tomber l'enrichissement pour une mauvaise raison.
 */
function userAgent(): string {
  try {
    return env().MUSICBRAINZ_USER_AGENT;
  } catch {
    return "Rotation/0.1 ( https://github.com/rotation )";
  }
}
