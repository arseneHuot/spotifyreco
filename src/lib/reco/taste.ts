import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Construction du profil de goût.
 *
 * Tout vient de Postgres, aucun appel réseau sortant : ce module est appelé au
 * début de chaque génération de lot et doit rester prévisible en latence.
 *
 * Contrainte légale, structurante ici : la Developer Policy Spotify interdit
 * d'entraîner un modèle sur du Spotify Content et d'en dériver des profils
 * d'utilisateurs. Le profil n'apprend donc que sur des attributs de sources
 * ouvertes — `tags` (Last.fm / MusicBrainz) et `track_features` (ReccoBeats).
 * `artists.spotify_genres` et `tracks.popularity` sont volontairement ignorés :
 * les identifiants Spotify ne servent que de clés de jointure.
 */

// ---------------------------------------------------------------------------
// Constantes de réglage
// ---------------------------------------------------------------------------

/**
 * Demi-vie de la décroissance temporelle des écoutes, en jours.
 *
 * 90 jours = une saison. Le goût musical dérive à cette échelle : ce qui
 * tournait en boucle il y a un trimestre compte encore pour moitié, ce qui date
 * d'un an ne pèse plus que 6 %. Une demi-vie plus courte (30 j) rendrait le
 * profil instable et le ferait osciller au gré d'une semaine d'écoute atypique ;
 * plus longue (365 j), le moteur resterait accroché à des goûts périmés — le
 * défaut exact que ce produit cherche à corriger.
 */
export const HALF_LIFE_DAYS = 90;

/**
 * Les écoutes au-delà de 6 demi-vies pèsent moins de 1,6 % : les charger
 * coûterait des pages de requête pour un effet invisible.
 */
const LISTEN_WINDOW_DAYS = HALF_LIFE_DAYS * 6;

/**
 * Plancher de décroissance appliqué aux notes explicites.
 *
 * Une note est une déclaration, pas une trace de comportement : elle ne se
 * périme pas au même rythme. On la fait vieillir quand même (les goûts bougent)
 * mais sans jamais descendre sous ce plancher.
 */
const RATING_DECAY_FLOOR = 0.35;

/** Poids relatif de chaque famille de signaux dans l'affinité d'un morceau. */
const SIGNAL_WEIGHTS = {
  rating: 1.6,
  completion: 0.5,
  repeat: 0.6,
  saved: 0.45,
  top: 0.5,
} as const;

/**
 * Atténuation des signaux implicites quand une note explicite existe.
 *
 * Un morceau noté 0 mais écouté en entier (une autre personne sur l'enceinte,
 * une playlist subie) ne doit pas remonter à zéro : la déclaration prime sur la
 * trace.
 */
const IMPLICIT_ATTENUATION_WHEN_RATED = 0.3;

/** En dessous, `completion` vaut signal négatif ; au-dessus de HIGH, positif. */
const COMPLETION_LOW = 0.3;
const COMPLETION_HIGH = 0.9;

/** Nombre de réécoutes au-delà duquel le bonus de répétition sature. */
const REPEAT_SATURATION = 8;

/** Poids de chaque fenêtre de `top_items`. */
const TOP_RANGE_WEIGHTS: Record<string, number> = {
  short_term: 1,
  medium_term: 0.85,
  long_term: 0.7,
};

/** Les tags d'artiste sont moins précis que ceux du morceau : on les décote. */
const ARTIST_TAG_FALLBACK_WEIGHT = 0.6;

/** Borne la taille du profil : au-delà, ce n'est plus que du bruit. */
const MAX_PROFILE_TAGS = 400;

/** Nombre minimal de morceaux observés sur une dimension pour oser un centroïde. */
const MIN_FEATURE_TRACKS = 5;

/** Un écart-type nul ferait diverger la normalisation dans `scoring.ts`. */
const MIN_FEATURE_SPREAD = 0.05;

/** Nombre de notes à partir duquel on recentre le pivot sur la moyenne du·de la user. */
const MIN_RATINGS_FOR_RECENTERING = 20;

/** Échelles de saturation de la confiance. */
const CONFIDENCE_SCALES = {
  tracks: 40,
  ratings: 15,
  artists: 25,
} as const;

/**
 * Sous ce nombre de morceaux connus, la confiance est bridée linéairement :
 * cinq morceaux ne font pas un goût, quelle que soit leur diversité.
 */
const COLD_START_TRACKS = 25;

/**
 * Taille des lots pour les filtres `in.(...)`.
 *
 * Vérifié empiriquement contre le projet : 1 000 identifiants (URL ≈ 23 ko)
 * passent, 1 300 (≈ 30 ko) sont rejetés par le proxy en amont de PostgREST avec
 * un `Bad Request` en texte brut — pas une erreur JSON PostgREST, donc
 * impossible à distinguer d'une panne côté application. 300 laisse une marge
 * large et garde des URL d'environ 7 ko.
 */
const IN_CHUNK_SIZE = 300;

/** Pagination des tables de signaux. */
const PAGE_SIZE = 1000;
const MAX_LISTENS = 20_000;
const MAX_ROWS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dimensions retenues du vecteur de caractéristiques.
 *
 * `key` et `mode` sont volontairement exclus : la tonalité est circulaire (11 et
 * 0 sont voisins, leur moyenne arithmétique n'a aucun sens) et le mode est
 * binaire. Les moyenner produirait un centroïde ininterprétable.
 */
export const FEATURE_KEYS = [
  "acousticness",
  "danceability",
  "energy",
  "instrumentalness",
  "liveness",
  "speechiness",
  "valence",
  "loudness",
  "tempo",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Toutes les dimensions ramenées à [0,1] (voir `normalizeFeatures`). */
export type FeatureVector = Record<FeatureKey, number>;

/** ReccoBeats ne renseigne pas systématiquement toutes les dimensions. */
export type PartialFeatureVector = Partial<Record<FeatureKey, number>>;

export type WeightedTag = { tagId: number; weight: number };

/**
 * Un morceau proposable, tel que le produit le module de génération de
 * candidats. Les caractéristiques sont déjà normalisées en [0,1].
 */
export type Candidate = {
  trackId: string;
  artistIds: string[];
  tags: WeightedTag[];
  features: PartialFeatureVector | null;
  /** Provenance ('artist_similarity', 'tag_neighbour', ...), tracée dans `reasons`. */
  source?: string;
};

export type TasteProfile = {
  /** tag_id -> poids dans [-1,1]. Négatif = attribut rejeté. */
  tagWeights: Map<number, number>;
  /**
   * Rejet pur, en magnitude positive, isolé de `tagWeights`.
   *
   * Nécessaire parce qu'un tag à la fois aimé et détesté (« rock » présent sur
   * des morceaux notés 5 et sur d'autres notés 0) s'annule dans la somme signée
   * et disparaîtrait du profil. La pénalité de `scoring.ts` a besoin du signal
   * de rejet intact, indépendamment de cette compensation.
   */
  rejectedTagWeights: Map<number, number>;
  artistWeights: Map<string, number>;
  featureCentroid: FeatureVector | null;
  /** Écart-type pondéré par dimension : mesure l'ouverture du goût. */
  featureSpread: FeatureVector | null;
  /** Tous les morceaux déjà vus, à exclure des recommandations. */
  knownTrackIds: Set<string>;
  /** Artistes déjà entendus, pour la composante de nouveauté. */
  knownArtistIds: Set<string>;
  sampleSize: number;
  confidence: number;
};

// ---------------------------------------------------------------------------
// Normalisation des caractéristiques
// ---------------------------------------------------------------------------

/**
 * Bornes de remise à l'échelle des deux dimensions qui ne sont pas en [0,1].
 *
 * Sans cela `loudness` (dB, ≈ -60..0) et `tempo` (BPM, ≈ 40..220) écraseraient
 * toutes les autres dans le calcul de distance.
 */
const FEATURE_RANGES: Partial<Record<FeatureKey, { min: number; max: number }>> =
  {
    loudness: { min: -60, max: 0 },
    tempo: { min: 40, max: 220 },
  };

/** Ramène une valeur brute de `track_features` dans [0,1]. */
export function normalizeFeature(key: FeatureKey, raw: number): number {
  const range = FEATURE_RANGES[key];
  if (!range) return clamp(raw, 0, 1);
  return clamp((raw - range.min) / (range.max - range.min), 0, 1);
}

/** Convertit une ligne `track_features` en vecteur normalisé, trous compris. */
export function normalizeFeatures(
  row: Partial<Record<FeatureKey, number | null>>,
): PartialFeatureVector {
  const out: PartialFeatureVector = {};
  for (const key of FEATURE_KEYS) {
    const raw = row[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = normalizeFeature(key, raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entrée principale
// ---------------------------------------------------------------------------

/**
 * Agrège tous les signaux d'un·e utilisateur·rice en un profil exploitable.
 *
 * Aucune requête n'est bloquante : si une table de signaux est indisponible, la
 * fonction se rabat sur les autres et renvoie un profil de confiance moindre
 * plutôt que de faire échouer la génération du lot.
 */
export async function buildTasteProfile(
  userId: string,
): Promise<TasteProfile> {
  const [ratings, listens, saved, tops] = await Promise.all([
    fetchRatings(userId),
    fetchListens(userId),
    fetchSavedTracks(userId),
    fetchTopItems(userId),
  ]);

  const now = Date.now();

  // 1. Affinité par morceau, dans [-1,1].
  const trackSignals = aggregateTrackSignals({
    ratings,
    listens,
    saved,
    tops,
    now,
  });

  const trackIds = [...trackSignals.keys()];

  // 2. Attributs des morceaux concernés (sources ouvertes uniquement).
  const [trackTags, trackArtists, trackFeatures] = await Promise.all([
    fetchTrackTags(trackIds),
    fetchTrackArtists(trackIds),
    fetchTrackFeatures(trackIds),
  ]);

  // 3. Artistes : signal direct des `top_items` + artistes des morceaux notés.
  const artistSignals = aggregateArtistSignals(
    trackSignals,
    trackArtists,
    tops,
    now,
  );

  const artistTags = await fetchArtistTags([...artistSignals.keys()]);

  const { tagWeights, rejectedTagWeights } = buildTagWeights(
    trackSignals,
    trackTags,
    trackArtists,
    artistTags,
  );

  const { centroid, spread } = buildFeatureStats(trackSignals, trackFeatures);

  const knownArtistIds = new Set<string>(artistSignals.keys());
  for (const artistIds of trackArtists.values()) {
    for (const id of artistIds) knownArtistIds.add(id);
  }

  return {
    tagWeights,
    rejectedTagWeights,
    artistWeights: normalizeByMaxMagnitude(artistSignals),
    featureCentroid: centroid,
    featureSpread: spread,
    knownTrackIds: new Set(trackIds),
    knownArtistIds,
    sampleSize: trackIds.length,
    confidence: computeConfidence({
      trackCount: trackIds.length,
      ratingCount: ratings.length,
      artistCount: knownArtistIds.size,
      tagCount: tagWeights.size,
    }),
  };
}

// ---------------------------------------------------------------------------
// Agrégation des signaux
// ---------------------------------------------------------------------------

type RatingRow = { track_id: string; rating: number; updated_at: string };
type ListenRow = {
  track_id: string;
  played_at: string;
  completion: number | null;
};
type SavedRow = { track_id: string; added_at: string };
type TopRow = {
  entity_type: string;
  entity_id: string;
  time_range: string;
  rank: number;
  captured_on: string;
};

/** Affinité signée d'un morceau, accompagnée de sa part explicitement rejetée. */
type TrackSignal = {
  /** Dans [-1,1]. */
  affinity: number;
  /** Magnitude du rejet explicite (note 0 ou 1), dans [0,1]. */
  rejection: number;
};

function aggregateTrackSignals(input: {
  ratings: RatingRow[];
  listens: ListenRow[];
  saved: SavedRow[];
  tops: TopRow[];
  now: number;
}): Map<string, TrackSignal> {
  const { ratings, listens, saved, tops, now } = input;

  const pivot = ratingPivot(ratings);
  const ratedTrackIds = new Set(ratings.map((r) => r.track_id));

  /** Contributions brutes, sommées avant écrasement dans [-1,1]. */
  const raw = new Map<string, number>();
  const rejection = new Map<string, number>();

  const add = (trackId: string, value: number): void => {
    raw.set(trackId, (raw.get(trackId) ?? 0) + value);
  };

  for (const row of ratings) {
    const score = ratingToScore(row.rating, pivot);
    const decay = Math.max(
      RATING_DECAY_FLOOR,
      timeDecay(row.updated_at, now),
    );
    add(row.track_id, SIGNAL_WEIGHTS.rating * score * decay);

    // Seules les notes franchement basses alimentent l'apprentissage du rejet :
    // un 2 est tiède, pas un refus.
    if (row.rating <= 1) {
      rejection.set(row.track_id, (2 - row.rating) / 2);
    }
  }

  // Le facteur d'atténuation dépend de l'existence d'une note sur le morceau.
  const implicitFactor = (trackId: string): number =>
    ratedTrackIds.has(trackId) ? IMPLICIT_ATTENUATION_WHEN_RATED : 1;

  const listenCount = new Map<string, number>();

  for (const row of listens) {
    listenCount.set(row.track_id, (listenCount.get(row.track_id) ?? 0) + 1);

    // `completion` est NULL dès que l'écoute vient de /me/player/recently-played,
    // qui ne renvoie jamais de durée écoutée. NULL n'est pas 0 : on n'en déduit
    // rien, le morceau ne compte alors que par sa présence et ses réécoutes.
    if (row.completion === null) continue;

    const score = completionToScore(row.completion);
    if (score === 0) continue;

    add(
      row.track_id,
      SIGNAL_WEIGHTS.completion *
        score *
        timeDecay(row.played_at, now) *
        implicitFactor(row.track_id),
    );
  }

  // Une réécoute est un vote. La première écoute ne l'est pas : elle peut venir
  // d'une playlist algorithmique, d'un album parcouru, d'un hasard.
  for (const [trackId, count] of listenCount) {
    if (count < 2) continue;
    const bonus =
      Math.log2(1 + (count - 1)) / Math.log2(1 + REPEAT_SATURATION);
    add(
      trackId,
      SIGNAL_WEIGHTS.repeat *
        Math.min(1, bonus) *
        implicitFactor(trackId),
    );
  }

  for (const row of saved) {
    add(
      row.track_id,
      SIGNAL_WEIGHTS.saved *
        timeDecay(row.added_at, now) *
        implicitFactor(row.track_id),
    );
  }

  for (const row of tops) {
    if (row.entity_type !== "track") continue;
    add(
      row.entity_id,
      SIGNAL_WEIGHTS.top *
        topItemScore(row) *
        timeDecay(row.captured_on, now) *
        implicitFactor(row.entity_id),
    );
  }

  const out = new Map<string, TrackSignal>();
  for (const [trackId, value] of raw) {
    out.set(trackId, {
      // `tanh` écrase sans jamais saturer brutalement : un morceau écouté
      // cinquante fois reste au-dessus d'un morceau écouté dix fois, sans pour
      // autant peser cinq fois plus dans le profil.
      affinity: Math.tanh(value),
      rejection: rejection.get(trackId) ?? 0,
    });
  }

  // Un morceau vu mais sans contribution nette reste « connu » : il doit être
  // exclu des recommandations même s'il n'apprend rien au profil.
  for (const trackId of [
    ...listenCount.keys(),
    ...saved.map((s) => s.track_id),
    ...tops.filter((t) => t.entity_type === "track").map((t) => t.entity_id),
  ]) {
    if (!out.has(trackId)) out.set(trackId, { affinity: 0, rejection: 0 });
  }

  return out;
}

/**
 * Pivot de la conversion note -> score.
 *
 * Le mapping demandé, (rating - 2.5) / 2.5, suppose que 2,5 est le point neutre.
 * C'est faux en pratique : les notations utilisateur sont en J, massées sur 3-5,
 * parce qu'on note surtout ce qu'on a choisi d'écouter. Avec un pivot fixe,
 * presque rien n'est jamais « rejeté » et le profil n'apprend qu'en positif —
 * exactement ce qui produit des recommandations qui tournent en rond.
 *
 * On recentre donc partiellement sur la moyenne observée, à mi-chemin au plus,
 * et seulement une fois assez de notes accumulées. Le déplacement reste borné :
 * un pivot entièrement adaptatif rendrait le profil incomparable dans le temps
 * et ferait basculer en négatif des morceaux réellement appréciés.
 */
function ratingPivot(ratings: RatingRow[]): number {
  const NEUTRAL = 2.5;
  if (ratings.length < MIN_RATINGS_FOR_RECENTERING) return NEUTRAL;

  const mean =
    ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;

  const alpha = 0.5 * Math.min(1, ratings.length / (2 * MIN_RATINGS_FOR_RECENTERING));
  return NEUTRAL + alpha * (mean - NEUTRAL);
}

/** Note 0..5 -> score dans [-1,1]. */
function ratingToScore(rating: number, pivot: number): number {
  const span = Math.max(pivot, 5 - pivot);
  const score = clamp((rating - pivot) / span, -1, 1);

  // Garde-fou : quel que soit le pivot, un 0 ou un 1 reste un refus net. Sans
  // cela, un profil très généreux (moyenne 4,5) rendrait un 1 « à peine tiède ».
  if (rating <= 1) return Math.min(score, (rating - 2.5) / 2.5);
  return score;
}

/**
 * `completion` -> score dans [-1,1].
 *
 * La zone médiane renvoie 0 volontairement : entre 30 % et 90 %, on ne sait pas
 * si le morceau a déplu ou si l'écoute a été interrompue par la vie réelle.
 */
function completionToScore(completion: number): number {
  if (completion < COMPLETION_LOW) {
    return -(COMPLETION_LOW - completion) / COMPLETION_LOW;
  }
  if (completion > COMPLETION_HIGH) {
    return (completion - COMPLETION_HIGH) / (1 - COMPLETION_HIGH);
  }
  return 0;
}

/** Score d'un `top_item`, combinant rang et fenêtre temporelle. */
function topItemScore(row: TopRow): number {
  const rangeWeight = TOP_RANGE_WEIGHTS[row.time_range] ?? 0.7;
  // Spotify renvoie au plus 50 entrées par fenêtre.
  const rankWeight = Math.max(0, 1 - (row.rank - 1) / 50);
  return rangeWeight * rankWeight;
}

function aggregateArtistSignals(
  trackSignals: Map<string, TrackSignal>,
  trackArtists: Map<string, string[]>,
  tops: TopRow[],
  now: number,
): Map<string, number> {
  const raw = new Map<string, number>();

  const add = (artistId: string, value: number): void => {
    raw.set(artistId, (raw.get(artistId) ?? 0) + value);
  };

  for (const [trackId, signal] of trackSignals) {
    if (signal.affinity === 0) continue;
    const artistIds = trackArtists.get(trackId);
    if (!artistIds?.length) continue;

    // Le crédit est partagé : sur un featuring, l'affinité ne vaut pas
    // pleinement pour chacun des artistes crédités.
    const share = signal.affinity / Math.sqrt(artistIds.length);
    for (const artistId of artistIds) add(artistId, share);
  }

  for (const row of tops) {
    if (row.entity_type !== "artist") continue;
    add(row.entity_id, topItemScore(row) * timeDecay(row.captured_on, now));
  }

  const out = new Map<string, number>();
  for (const [artistId, value] of raw) out.set(artistId, Math.tanh(value));
  return out;
}

// ---------------------------------------------------------------------------
// Tags et pondération IDF
// ---------------------------------------------------------------------------

function buildTagWeights(
  trackSignals: Map<string, TrackSignal>,
  trackTags: Map<string, WeightedTag[]>,
  trackArtists: Map<string, string[]>,
  artistTags: Map<string, WeightedTag[]>,
): {
  tagWeights: Map<number, number>;
  rejectedTagWeights: Map<number, number>;
} {
  // Vue « un morceau = un sac de tags », en complétant par les tags de l'artiste
  // quand le morceau lui-même n'est pas tagué (cas fréquent : Last.fm tague
  // beaucoup mieux les artistes que les titres).
  const bags = new Map<string, WeightedTag[]>();

  for (const trackId of trackSignals.keys()) {
    const own = trackTags.get(trackId) ?? [];
    const merged = new Map<number, number>();

    for (const tag of own) {
      merged.set(tag.tagId, Math.max(merged.get(tag.tagId) ?? 0, tag.weight));
    }

    for (const artistId of trackArtists.get(trackId) ?? []) {
      for (const tag of artistTags.get(artistId) ?? []) {
        const value = tag.weight * ARTIST_TAG_FALLBACK_WEIGHT;
        merged.set(tag.tagId, Math.max(merged.get(tag.tagId) ?? 0, value));
      }
    }

    if (merged.size > 0) {
      bags.set(
        trackId,
        [...merged].map(([tagId, weight]) => ({ tagId, weight })),
      );
    }
  }

  const documentCount = bags.size;
  if (documentCount === 0) {
    return { tagWeights: new Map(), rejectedTagWeights: new Map() };
  }

  // Fréquence documentaire : sur combien de morceaux du corpus le tag apparaît.
  const documentFrequency = new Map<number, number>();
  for (const tags of bags.values()) {
    for (const tag of tags) {
      documentFrequency.set(
        tag.tagId,
        (documentFrequency.get(tag.tagId) ?? 0) + 1,
      );
    }
  }

  const accumulated = new Map<number, number>();
  const rejected = new Map<number, number>();

  for (const [trackId, tags] of bags) {
    const signal = trackSignals.get(trackId);
    if (!signal) continue;

    for (const tag of tags) {
      const idf = inverseDocumentFrequency(
        documentFrequency.get(tag.tagId) ?? 0,
        documentCount,
      );
      const contribution = signal.affinity * tag.weight * idf;
      accumulated.set(
        tag.tagId,
        (accumulated.get(tag.tagId) ?? 0) + contribution,
      );

      if (signal.rejection > 0) {
        rejected.set(
          tag.tagId,
          (rejected.get(tag.tagId) ?? 0) + signal.rejection * tag.weight * idf,
        );
      }
    }
  }

  return {
    tagWeights: pruneAndNormalize(accumulated, MAX_PROFILE_TAGS),
    rejectedTagWeights: pruneAndNormalize(rejected, MAX_PROFILE_TAGS),
  };
}

/**
 * IDF lissée.
 *
 * Un tag porté par presque tous les morceaux écoutés ne dit rien du goût : si
 * 95 % du corpus est taggé « rock », « rock » ne discrimine aucun candidat et
 * ne doit pas dominer le produit scalaire. La forme `ln(1 + N/(1+df))` tend vers
 * ln(2) ≈ 0,69 pour un tag universel et croît sans borne dure pour un tag rare,
 * ce qui donne au tag de niche le poids qu'il mérite sans jamais annuler
 * complètement le tag générique (qui reste une information, faible).
 */
function inverseDocumentFrequency(
  documentFrequency: number,
  documentCount: number,
): number {
  return Math.log(1 + documentCount / (1 + documentFrequency));
}

/** Ne garde que les N plus fortes magnitudes, puis ramène le maximum à 1. */
function pruneAndNormalize(
  weights: Map<number, number>,
  limit: number,
): Map<number, number> {
  const entries = [...weights].filter(([, value]) => value !== 0);
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const kept = entries.slice(0, limit);
  const max = kept.reduce((m, [, value]) => Math.max(m, Math.abs(value)), 0);
  if (max === 0) return new Map();

  return new Map(kept.map(([tagId, value]) => [tagId, value / max]));
}

function normalizeByMaxMagnitude(
  weights: Map<string, number>,
): Map<string, number> {
  let max = 0;
  for (const value of weights.values()) max = Math.max(max, Math.abs(value));
  if (max === 0) return new Map(weights);

  const out = new Map<string, number>();
  for (const [key, value] of weights) out.set(key, value / max);
  return out;
}

// ---------------------------------------------------------------------------
// Centroïde et dispersion des caractéristiques
// ---------------------------------------------------------------------------

/**
 * Moyenne et écart-type pondérés, dimension par dimension.
 *
 * Seuls les morceaux d'affinité positive entrent dans le centroïde : la moyenne
 * de ce qu'on aime et de ce qu'on déteste ne décrit rien. Le rejet est traité
 * séparément, au niveau des tags.
 *
 * Chaque dimension a son propre dénominateur : ReccoBeats laisse des trous, et
 * traiter un trou comme un zéro tirerait le centroïde vers le bas.
 */
function buildFeatureStats(
  trackSignals: Map<string, TrackSignal>,
  trackFeatures: Map<string, PartialFeatureVector>,
): { centroid: FeatureVector | null; spread: FeatureVector | null } {
  const sumWeight: Record<string, number> = {};
  const sumValue: Record<string, number> = {};
  const sumSquare: Record<string, number> = {};
  const observations: Record<string, number> = {};

  for (const [trackId, signal] of trackSignals) {
    if (signal.affinity <= 0) continue;
    const features = trackFeatures.get(trackId);
    if (!features) continue;

    for (const key of FEATURE_KEYS) {
      const value = features[key];
      if (value === undefined) continue;

      sumWeight[key] = (sumWeight[key] ?? 0) + signal.affinity;
      sumValue[key] = (sumValue[key] ?? 0) + signal.affinity * value;
      sumSquare[key] = (sumSquare[key] ?? 0) + signal.affinity * value * value;
      observations[key] = (observations[key] ?? 0) + 1;
    }
  }

  const covered = FEATURE_KEYS.filter(
    (key) => (observations[key] ?? 0) >= MIN_FEATURE_TRACKS,
  );
  if (covered.length === 0) return { centroid: null, spread: null };

  const centroid = {} as FeatureVector;
  const spread = {} as FeatureVector;

  for (const key of FEATURE_KEYS) {
    const weight = sumWeight[key] ?? 0;

    // Dimension trop peu observée : centre neutre et dispersion maximale, ce qui
    // neutralise la composante dans `scoring.ts` au lieu d'inventer une
    // préférence sur la base de deux morceaux.
    if (weight <= 0 || (observations[key] ?? 0) < MIN_FEATURE_TRACKS) {
      centroid[key] = 0.5;
      spread[key] = 1;
      continue;
    }

    const mean = (sumValue[key] ?? 0) / weight;
    const variance = (sumSquare[key] ?? 0) / weight - mean * mean;

    centroid[key] = clamp(mean, 0, 1);
    spread[key] = Math.max(MIN_FEATURE_SPREAD, Math.sqrt(Math.max(0, variance)));
  }

  return { centroid, spread };
}

// ---------------------------------------------------------------------------
// Confiance
// ---------------------------------------------------------------------------

/**
 * Confiance dans le profil, dans [0,1].
 *
 * Trois axes complémentaires : le volume (combien de morceaux), l'explicite
 * (combien de notes — c'est ce qui rend un profil fiable) et la diversité
 * (combien d'artistes et de tags distincts ; cent écoutes du même album ne
 * décrivent pas un goût). Le produit final est bridé au démarrage par un facteur
 * linéaire, pour qu'un compte tout neuf n'affiche jamais une fausse assurance.
 */
function computeConfidence(input: {
  trackCount: number;
  ratingCount: number;
  artistCount: number;
  tagCount: number;
}): number {
  const { trackCount, ratingCount, artistCount, tagCount } = input;
  if (trackCount === 0) return 0;

  const volume = saturate(trackCount, CONFIDENCE_SCALES.tracks);
  const explicit = saturate(ratingCount, CONFIDENCE_SCALES.ratings);
  const diversity =
    0.6 * saturate(artistCount, CONFIDENCE_SCALES.artists) +
    0.4 * saturate(tagCount, MAX_PROFILE_TAGS / 4);

  const blended = 0.4 * volume + 0.3 * explicit + 0.3 * diversity;
  const coldStart = Math.min(1, trackCount / COLD_START_TRACKS);

  return clamp(blended * coldStart, 0, 1);
}

/** Croissance concave saturant vers 1 : 1 - exp(-x/scale). */
function saturate(value: number, scale: number): number {
  return 1 - Math.exp(-value / scale);
}

// ---------------------------------------------------------------------------
// Décroissance temporelle
// ---------------------------------------------------------------------------

/** exp(-ln(2) * âge / demi-vie). Vaut 1 aujourd'hui, 0.5 après une demi-vie. */
export function timeDecay(
  timestamp: string,
  now: number,
  halfLifeDays: number = HALF_LIFE_DAYS,
): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 0;

  const ageDays = (now - parsed) / 86_400_000;
  // Un horodatage dans le futur (dérive d'horloge, `captured_on` en date pure
  // interprétée en UTC) ne doit pas produire un poids supérieur à 1.
  if (ageDays <= 0) return 1;

  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

// ---------------------------------------------------------------------------
// Accès aux données
// ---------------------------------------------------------------------------

/**
 * Exécute une requête paginée, sans jamais faire échouer l'appelant.
 *
 * PostgREST plafonne le nombre de lignes par réponse (`max-rows`), et la valeur
 * n'est pas connue de l'application : on pagine systématiquement par `range`
 * plutôt que de faire confiance à un `limit` élevé, qui serait tronqué en
 * silence — un profil calculé sur un sous-ensemble arbitraire des écoutes est
 * pire qu'un profil vide, parce qu'il a l'air correct.
 *
 * En cas d'échec en cours de pagination, les pages déjà obtenues sont conservées.
 * Ce n'est pas contradictoire avec ce qui précède : les quatre requêtes de ce
 * module trient par récence décroissante, donc une pagination interrompue rend
 * une fenêtre plus courte, pas un échantillon arbitraire. Même raisonnement pour
 * l'arrêt à `maxRows`.
 */
async function paginate<T>(
  label: string,
  maxRows: number,
  query: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];

  try {
    for (let from = 0; from < maxRows; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE, maxRows) - 1;
      const { data, error } = await query(from, to);

      if (error) {
        console.error(`[taste] ${label} : ${error.message}`);
        break;
      }
      if (!data?.length) break;

      out.push(...data);
      if (data.length < to - from + 1) break;
    }
  } catch (cause) {
    console.error(`[taste] ${label} :`, cause);
  }

  return out;
}

async function fetchRatings(userId: string): Promise<RatingRow[]> {
  const admin = createAdminClient();
  return paginate<RatingRow>("ratings", MAX_ROWS, (from, to) =>
    admin
      .from("ratings")
      .select("track_id, rating, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .range(from, to),
  );
}

async function fetchListens(userId: string): Promise<ListenRow[]> {
  const admin = createAdminClient();
  const since = new Date(
    Date.now() - LISTEN_WINDOW_DAYS * 86_400_000,
  ).toISOString();

  return paginate<ListenRow>("listens", MAX_LISTENS, (from, to) =>
    admin
      .from("listens")
      .select("track_id, played_at, completion")
      .eq("user_id", userId)
      .gte("played_at", since)
      .order("played_at", { ascending: false })
      .range(from, to),
  );
}

async function fetchSavedTracks(userId: string): Promise<SavedRow[]> {
  const admin = createAdminClient();
  return paginate<SavedRow>("saved_tracks", MAX_ROWS, (from, to) =>
    admin
      .from("saved_tracks")
      .select("track_id, added_at")
      .eq("user_id", userId)
      .order("added_at", { ascending: false })
      .range(from, to),
  );
}

async function fetchTopItems(userId: string): Promise<TopRow[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 180 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const rows = await paginate<TopRow>("top_items", MAX_ROWS, (from, to) =>
    admin
      .from("top_items")
      .select("entity_type, entity_id, time_range, rank, captured_on")
      .eq("user_id", userId)
      .gte("captured_on", since)
      .order("captured_on", { ascending: false })
      .range(from, to),
  );

  return latestTopSnapshots(rows);
}

/**
 * Ne garde que le snapshot le plus récent par (type, entité, fenêtre).
 *
 * `top_items` a pour clé primaire (user_id, entity_type, time_range, entity_id,
 * **captured_on**) : c'est une série temporelle, une ligne par jour de synchro et
 * non un classement courant. Sommer toutes les lignes multiplierait le signal par
 * le nombre de captures — jusqu'à 180 sur la fenêtre lue ici — et
 * `Math.tanh` saturerait à 1 pour tout ce qui a un jour figuré dans un top.
 *
 * L'effet mesuré était une inversion de signe : un morceau noté 0, mais resté
 * dans les tops, ressortait avec un poids de tag de +1 au lieu de -1. La
 * décroissance temporelle s'applique ensuite à la date de la dernière capture, ce
 * qui fait bien décroître un artiste sorti des classements.
 */
function latestTopSnapshots(rows: TopRow[]): TopRow[] {
  const latest = new Map<string, TopRow>();

  for (const row of rows) {
    const key = `${row.entity_type}\u0000${row.time_range}\u0000${row.entity_id}`;
    const current = latest.get(key);
    if (!current || row.captured_on > current.captured_on) {
      latest.set(key, row);
    }
  }

  return [...latest.values()];
}

/**
 * Découpe une liste d'identifiants en lots pour les filtres `in.(...)`.
 *
 * Voir `IN_CHUNK_SIZE` : au-delà d'environ 1 000 identifiants, l'URL est
 * rejetée en amont de PostgREST.
 */
async function fetchChunked<T>(
  label: string,
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];

  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CHUNK_SIZE);
    try {
      const { data, error } = await query(chunk);
      if (error) {
        console.error(`[taste] ${label} : ${error.message}`);
        continue;
      }
      if (data) out.push(...data);
    } catch (cause) {
      console.error(`[taste] ${label} :`, cause);
    }
  }

  return out;
}

async function fetchTrackTags(
  trackIds: string[],
): Promise<Map<string, WeightedTag[]>> {
  if (trackIds.length === 0) return new Map();
  const admin = createAdminClient();

  const rows = await fetchChunked<{
    track_id: string;
    tag_id: number;
    weight: number;
  }>("track_tags", trackIds, (chunk) =>
    admin
      .from("track_tags")
      .select("track_id, tag_id, weight")
      .in("track_id", chunk),
  );

  const out = new Map<string, WeightedTag[]>();
  for (const row of rows) {
    const list = out.get(row.track_id) ?? [];
    list.push({ tagId: row.tag_id, weight: row.weight });
    out.set(row.track_id, list);
  }
  return out;
}

async function fetchArtistTags(
  artistIds: string[],
): Promise<Map<string, WeightedTag[]>> {
  if (artistIds.length === 0) return new Map();
  const admin = createAdminClient();

  const rows = await fetchChunked<{
    artist_id: string;
    tag_id: number;
    weight: number;
  }>("artist_tags", artistIds, (chunk) =>
    admin
      .from("artist_tags")
      .select("artist_id, tag_id, weight")
      .in("artist_id", chunk),
  );

  const out = new Map<string, WeightedTag[]>();
  for (const row of rows) {
    const list = out.get(row.artist_id) ?? [];
    list.push({ tagId: row.tag_id, weight: row.weight });
    out.set(row.artist_id, list);
  }
  return out;
}

async function fetchTrackArtists(
  trackIds: string[],
): Promise<Map<string, string[]>> {
  if (trackIds.length === 0) return new Map();
  const admin = createAdminClient();

  const rows = await fetchChunked<{
    track_id: string;
    artist_id: string;
    position: number;
  }>("track_artists", trackIds, (chunk) =>
    admin
      .from("track_artists")
      .select("track_id, artist_id, position")
      .in("track_id", chunk)
      .order("position", { ascending: true }),
  );

  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.track_id) ?? [];
    list.push(row.artist_id);
    out.set(row.track_id, list);
  }
  return out;
}

async function fetchTrackFeatures(
  trackIds: string[],
): Promise<Map<string, PartialFeatureVector>> {
  if (trackIds.length === 0) return new Map();
  const admin = createAdminClient();

  const rows = await fetchChunked<
    { track_id: string } & Record<FeatureKey, number | null>
  >("track_features", trackIds, (chunk) =>
    admin
      .from("track_features")
      .select(
        "track_id, acousticness, danceability, energy, instrumentalness, liveness, speechiness, valence, loudness, tempo",
      )
      .in("track_id", chunk),
  );

  const out = new Map<string, PartialFeatureVector>();
  for (const row of rows) out.set(row.track_id, normalizeFeatures(row));
  return out;
}

// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
