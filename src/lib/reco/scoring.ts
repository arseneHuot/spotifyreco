import "server-only";

import {
  FEATURE_KEYS,
  clamp,
  type Candidate,
  type TasteProfile,
  type WeightedTag,
} from "@/lib/reco/taste";

/**
 * Formules de score.
 *
 * Le score total est une somme pondérée de composantes **nommées**, chacune
 * bornée dans [-1,1] et reportée telle quelle dans `reasons`. Cette contrainte
 * n'est pas cosmétique : `recommendations.reasons` est ce qui permettra
 * d'expliquer « pourquoi ce morceau » à l'utilisateur·rice et de déboguer le
 * moteur a posteriori. Un score opaque serait invérifiable.
 *
 * Comme dans `taste.ts`, seules des données de sources ouvertes entrent dans le
 * calcul : tags Last.fm / MusicBrainz et caractéristiques ReccoBeats.
 */

// ---------------------------------------------------------------------------
// Pondérations
// ---------------------------------------------------------------------------

/**
 * Poids de chaque composante. Exportés et modifiables sans toucher aux formules.
 *
 * `penaliteNegative` est délibérément le poids le plus élevé : se tromper en
 * proposant quelque chose d'explicitement rejeté coûte beaucoup plus cher, en
 * confiance, que de rater une bonne suggestion.
 */
export const SCORING_WEIGHTS = {
  affiniteTags: 1,
  affiniteArtiste: 0.7,
  proximiteFeatures: 0.5,
  nouveaute: 0.35,
  penaliteNegative: 1.2,
} as const;

export type ScoringWeights = typeof SCORING_WEIGHTS;
export type ComponentName = keyof ScoringWeights;

/**
 * Largeur de la tolérance sur les caractéristiques, en écarts-types.
 *
 * Un candidat à moins de 2 écarts-types du centroïde est considéré comme dans le
 * goût. C'est ce qui traduit l'exigence « si le goût est large sur une dimension,
 * s'en écarter ne doit pas être pénalisé » : la dispersion observée est l'unité
 * de mesure, pas une distance absolue.
 */
export const FEATURE_TOLERANCE_SIGMA = 2;

/**
 * Atténuation de la proximité de caractéristiques quand le profil est faible.
 *
 * Un centroïde calculé sur douze morceaux décrit surtout le hasard des douze
 * premiers. On lui fait proportionnellement moins confiance.
 */
const FEATURE_CONFIDENCE_FLOOR = 0.3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoredCandidate = {
  trackId: string;
  score: number;
  /** Valeur brute (non pondérée) de chaque composante, plus `total`. */
  reasons: Record<string, number>;
  /**
   * Candidat d'origine, conservé pour l'étape de diversification.
   *
   * `diversity.ts` a besoin des tags (similarité cosinus du MMR) et des artistes
   * (anti-répétition). Les rechercher à nouveau en base après le scoring serait
   * une requête de plus par lot, pour une donnée qu'on a déjà en main.
   */
  candidate: Candidate;
};

// ---------------------------------------------------------------------------
// Entrée principale
// ---------------------------------------------------------------------------

/**
 * Note chaque candidat. Les candidats déjà connus sont écartés en amont —
 * `knownTrackIds` est la seule garantie qu'on ne re-propose pas indéfiniment le
 * même morceau.
 */
export function scoreCandidates(
  candidates: Candidate[],
  profile: TasteProfile,
  weights: ScoringWeights = SCORING_WEIGHTS,
): ScoredCandidate[] {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const out: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    if (profile.knownTrackIds.has(candidate.trackId)) continue;

    const components: Record<ComponentName, number> = {
      affiniteTags: tagAffinity(candidate.tags, profile.tagWeights),
      affiniteArtiste: artistAffinity(candidate.artistIds, profile.artistWeights),
      proximiteFeatures: featureProximity(candidate.features, profile),
      nouveaute: novelty(candidate.artistIds, profile.knownArtistIds),
      penaliteNegative: negativePenalty(
        candidate.tags,
        profile.rejectedTagWeights,
      ),
    };

    let weighted = 0;
    for (const name of Object.keys(components) as ComponentName[]) {
      weighted += weights[name] * components[name];
    }

    // Division par la somme des poids : le score reste dans [-1,1] et garde le
    // même sens quel que soit le réglage des pondérations. Sans cela, augmenter
    // un poids déplacerait l'échelle entière et rendrait incomparables deux lots
    // générés avec des réglages différents.
    const score = totalWeight > 0 ? weighted / totalWeight : 0;

    out.push({
      trackId: candidate.trackId,
      score,
      reasons: { ...components, total: score },
      candidate,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// Composantes
// ---------------------------------------------------------------------------

/**
 * Affinité entre les tags d'un candidat et le profil : moyenne des poids de
 * profil, pondérée par le poids de chaque tag chez le candidat.
 *
 * Les poids de profil sortent de `pruneAndNormalize` déjà ramenés dans [-1,1],
 * donc la moyenne l'est aussi : pas de renormalisation supplémentaire, et
 * l'échelle reste comparable à celle des autres composantes (contrairement à un
 * cosinus pris sur la norme complète du profil, qui écraserait toutes les valeurs
 * vers 0,02-0,08 et laisserait `nouveaute`, qui vaut 0 ou 1, dominer).
 *
 * Les tags du candidat inconnus du profil comptent au dénominateur mais pas au
 * numérateur : un candidat dont un seul tag sur dix correspond est légitimement
 * moins bien noté qu'un candidat qui correspond en totalité.
 *
 * Un cosinus restreint au support du candidat a été essayé et donne un résultat
 * faux : il divise par la norme du profil **restreinte aux tags appariés**, ce
 * qui élimine complètement la magnitude des poids. Mesuré — un candidat portant
 * le tag préféré (poids 1) et un candidat portant deux tags marginaux
 * (poids 0,05) obtenaient tous deux exactement 1,0. La composante la plus lourde
 * du score devenait aveugle à l'intensité du goût, seule comptait la proportion
 * de tags appariés.
 */
export function tagAffinity(
  tags: WeightedTag[],
  profileWeights: Map<number, number>,
): number {
  if (tags.length === 0 || profileWeights.size === 0) return 0;

  let weighted = 0;
  let totalWeight = 0;

  for (const tag of tags) {
    // Un poids de tag négatif n'a pas de sens et retournerait le signe de la
    // contribution : on raisonne sur la magnitude.
    const weight = Math.abs(tag.weight);
    if (!Number.isFinite(weight) || weight === 0) continue;

    totalWeight += weight;
    weighted += (profileWeights.get(tag.tagId) ?? 0) * weight;
  }

  if (totalWeight === 0) return 0;

  return clamp(weighted / totalWeight, -1, 1);
}

/**
 * Affinité avec les artistes crédités.
 *
 * On prend le maximum, pas la moyenne : sur un featuring entre un artiste adoré
 * et un inconnu, la moyenne diviserait par deux une affinité qui est bien réelle.
 * Un artiste explicitement rejeté (poids négatif) l'emporte cependant sur les
 * autres — d'où le maximum en magnitude signée plutôt que le maximum arithmétique.
 */
export function artistAffinity(
  artistIds: string[],
  profileWeights: Map<string, number>,
): number {
  let best = 0;

  for (const artistId of artistIds) {
    const weight = profileWeights.get(artistId);
    if (weight === undefined) continue;
    if (Math.abs(weight) > Math.abs(best)) best = weight;
  }

  return clamp(best, -1, 1);
}

/**
 * Proximité au centroïde, normalisée dimension par dimension par la dispersion.
 *
 * Une distance nulle vaut +1, une distance de `FEATURE_TOLERANCE_SIGMA`
 * écarts-types ou plus vaut -1. Les dimensions absentes du candidat sont
 * ignorées plutôt que comptées comme un écart maximal : ReccoBeats laisse des
 * trous, et pénaliser un candidat pour une donnée manquante reviendrait à
 * privilégier les morceaux les mieux documentés, pas les mieux adaptés.
 */
export function featureProximity(
  features: Candidate["features"],
  profile: TasteProfile,
): number {
  const { featureCentroid, featureSpread } = profile;
  if (!features || !featureCentroid || !featureSpread) return 0;

  let sum = 0;
  let count = 0;

  for (const key of FEATURE_KEYS) {
    const value = features[key];
    if (value === undefined) continue;

    const distance = Math.abs(value - featureCentroid[key]);
    const normalized = distance / (featureSpread[key] * FEATURE_TOLERANCE_SIGMA);

    sum += Math.min(1, normalized);
    count++;
  }

  if (count === 0) return 0;

  const proximity = 1 - 2 * (sum / count);

  // Le centroïde est d'autant moins crédible que le profil est jeune.
  const trust = FEATURE_CONFIDENCE_FLOOR + (1 - FEATURE_CONFIDENCE_FLOOR) * profile.confidence;

  return clamp(proximity * trust, -1, 1);
}

/**
 * Bonus de nouveauté : 1 si aucun des artistes crédités n'a jamais été entendu.
 *
 * Binaire à dessein. Un artiste est nouveau ou il ne l'est pas ; graduer sur le
 * nombre d'artistes déjà connus récompenserait les featurings, ce qui n'a rien à
 * voir avec la découverte. Le dosage exploitation/exploration se joue dans
 * `diversity.ts`, pas ici.
 */
export function novelty(
  artistIds: string[],
  knownArtistIds: Set<string>,
): number {
  if (artistIds.length === 0) return 0;
  return artistIds.some((id) => knownArtistIds.has(id)) ? 0 : 1;
}

/**
 * Pénalité de proximité avec ce qui a été explicitement rejeté (notes 0 et 1).
 *
 * Renvoie une valeur dans [-1,0], appliquée avec un poids positif : elle peut
 * donc à elle seule faire passer le score total en négatif, ce qui est
 * l'objectif. Un candidat qui coche exactement les attributs de ce qu'on a
 * détesté ne doit pas se rattraper par sa nouveauté.
 */
export function negativePenalty(
  tags: WeightedTag[],
  rejectedWeights: Map<number, number>,
): number {
  if (rejectedWeights.size === 0) return 0;
  return -Math.abs(tagAffinity(tags, rejectedWeights));
}
