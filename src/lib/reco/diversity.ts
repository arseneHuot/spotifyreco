import "server-only";

import type { ScoredCandidate } from "@/lib/reco/scoring";
import { clamp, type TasteProfile, type WeightedTag } from "@/lib/reco/taste";

/**
 * Diversité et exploration.
 *
 * Le classement par score seul converge : les meilleurs candidats se ressemblent
 * entre eux, le lot suivant ressemble au précédent, et le moteur s'enferme. Trois
 * mécanismes s'y opposent ici, dans cet ordre :
 *
 *  1. MMR — écarte les quasi-doublons *à l'intérieur* d'un lot ;
 *  2. échantillonnage de Thompson — arbitre exploitation/exploration sur des
 *     familles de tags, en apprenant des lots précédents ;
 *  3. quota d'exploration plancher — garantit une part de découverte même quand
 *     le profil est très marqué et que le modèle « sait » ce qui plaira.
 *
 * Le point 3 est un choix produit assumé : il coûte de la pertinence à court
 * terme. C'est le prix de la variété continue, qui est ici une exigence de
 * premier ordre et non un bonus.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Compromis pertinence / diversité du MMR. 0 = diversité pure, 1 = score pur. */
export const DEFAULT_MMR_LAMBDA = 0.7;

/**
 * Part minimale du lot issue de l'exploration.
 *
 * Plancher, pas cible : la valeur peut être relevée mais le moteur ne descend
 * jamais en dessous, quelle que soit la confiance du profil.
 */
export const DEFAULT_EXPLORATION_RATE = 0.25;

/** Un seul morceau par artiste dans un lot, par défaut. */
export const DEFAULT_MAX_PER_ARTIST = 1;

/**
 * Similarité retenue quand l'un des deux morceaux n'a aucun tag.
 *
 * Ni 0 ni 1 : un morceau non taggé n'est pas « très différent », il est inconnu.
 * À 0, tous les morceaux non enrichis paraîtraient maximalement diversifiants et
 * satureraient les lots — un défaut de couverture des données se transformerait
 * en biais de recommandation.
 */
const UNKNOWN_SIMILARITY = 0.5;

/**
 * Profondeur de pool explorée par le MMR, en multiple des places à pourvoir.
 *
 * Le MMR est quadratique en nombre d'éléments retenus : le laisser courir sur
 * plusieurs milliers de candidats coûterait des secondes pour un gain nul, les
 * candidats de queue n'ayant aucune chance d'être choisis.
 */
const MMR_POOL_FACTOR = 8;

/** Tirages de Thompson accordés avant de renoncer à un bras vide. */
const MAX_ARM_DRAWS = 12;

// ---------------------------------------------------------------------------
// 1. MMR
// ---------------------------------------------------------------------------

/**
 * Maximal Marginal Relevance.
 *
 * Sélection itérative : à chaque tour on retient l'élément qui maximise
 * `lambda * pertinence - (1 - lambda) * max(similarité avec les déjà retenus)`.
 *
 * La pertinence est ramenée en [0,1] par min-max sur l'ensemble fourni, faute de
 * quoi les deux termes ne seraient pas comparables : les scores vivent dans
 * [-1,1] et les similarités dans [0,1]. Sans cette remise à l'échelle, `lambda`
 * ne voudrait rien dire — 0,7 pénaliserait la diversité bien plus que prévu sur
 * un lot de scores négatifs.
 */
export function mmrRerank<T>(
  items: readonly T[],
  k: number,
  lambda: number,
  similarity: (a: T, b: T) => number,
  relevance: (item: T) => number = defaultRelevance,
): T[] {
  const limit = Math.min(k, items.length);
  if (limit <= 0) return [];

  const raw = items.map(relevance);
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  const span = max - min;

  // Tous les scores égaux : la pertinence n'apporte plus d'information, seule la
  // diversité départage.
  const normalized = raw.map((value) => (span > 0 ? (value - min) / span : 1));

  const remaining = items.map((_, index) => index);
  const selected: number[] = [];

  while (selected.length < limit && remaining.length > 0) {
    let bestPosition = 0;
    let bestValue = -Infinity;

    for (let position = 0; position < remaining.length; position++) {
      const index = remaining[position];

      let maxSimilarity = 0;
      for (const chosen of selected) {
        const value = similarity(items[index], items[chosen]);
        if (value > maxSimilarity) maxSimilarity = value;
      }

      const mmr =
        lambda * normalized[index] - (1 - lambda) * maxSimilarity;

      if (mmr > bestValue) {
        bestValue = mmr;
        bestPosition = position;
      }
    }

    selected.push(remaining[bestPosition]);
    remaining.splice(bestPosition, 1);
  }

  return selected.map((index) => items[index]);
}

function defaultRelevance(item: unknown): number {
  if (typeof item === "object" && item !== null && "score" in item) {
    const score = (item as { score: unknown }).score;
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  return 0;
}

/** Cosinus sur les tags, avec l'identité d'artiste comme court-circuit. */
export function tagCosine(a: WeightedTag[], b: WeightedTag[]): number {
  if (a.length === 0 || b.length === 0) return UNKNOWN_SIMILARITY;

  const left = new Map<number, number>();
  for (const tag of a) left.set(tag.tagId, tag.weight);

  let dot = 0;
  let normB = 0;
  for (const tag of b) {
    normB += tag.weight * tag.weight;
    const other = left.get(tag.tagId);
    if (other !== undefined) dot += other * tag.weight;
  }

  let normA = 0;
  for (const weight of left.values()) normA += weight * weight;

  if (normA === 0 || normB === 0) return UNKNOWN_SIMILARITY;
  return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), 0, 1);
}

/**
 * Similarité entre deux candidats.
 *
 * Deux morceaux du même artiste sont considérés comme identiques du point de vue
 * de la diversité, quels que soient leurs tags : c'est le même choix éditorial
 * proposé deux fois.
 */
export function candidateSimilarity(
  a: ScoredCandidate,
  b: ScoredCandidate,
): number {
  const artists = new Set(a.candidate.artistIds);
  if (b.candidate.artistIds.some((id) => artists.has(id))) return 1;

  return tagCosine(a.candidate.tags, b.candidate.tags);
}

// ---------------------------------------------------------------------------
// 2. Échantillonnage de Thompson
// ---------------------------------------------------------------------------

export type Arm = { successes: number; failures: number };

/**
 * Tire une loi normale centrée réduite (Box-Muller).
 *
 * `random()` peut renvoyer exactement 0, ce qui ferait diverger le logarithme :
 * on redemande tant que c'est le cas.
 */
function sampleNormal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Loi Gamma(shape, 1) par la méthode de Marsaglia-Tsang.
 *
 * Méthode de rejet à taux d'acceptation très élevé (> 96 %) et sans dépendance
 * externe. Elle exige `shape >= 1` ; en dessous on passe par l'identité
 * Gamma(a) = Gamma(a+1) · U^(1/a), qui reste exacte.
 */
export function sampleGamma(
  shape: number,
  random: () => number = Math.random,
): number {
  if (!(shape > 0)) return 0;

  if (shape < 1) {
    let u = 0;
    while (u === 0) u = random();
    return sampleGamma(shape + 1, random) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(random);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;

    let u = 0;
    while (u === 0) u = random();

    const xSquared = x * x;

    // Test rapide : évite un logarithme dans la grande majorité des cas.
    if (u < 1 - 0.0331 * xSquared * xSquared) return d * v;
    if (Math.log(u) < 0.5 * xSquared + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Loi Beta(alpha, beta) = X / (X + Y) avec X ~ Gamma(alpha), Y ~ Gamma(beta). */
export function sampleBeta(
  alpha: number,
  beta: number,
  random: () => number = Math.random,
): number {
  const x = sampleGamma(alpha, random);
  const y = sampleGamma(beta, random);
  const sum = x + y;

  // Deux tirages nuls simultanés sont possibles pour des paramètres très petits.
  if (!Number.isFinite(sum) || sum <= 0) return 0.5;

  return clamp(x / sum, 0, 1);
}

/**
 * Échantillonnage de Thompson : renvoie l'indice du bras gagnant.
 *
 * Chaque bras est une famille de tags dont on connaît l'historique
 * (recommandations bien notées contre ignorées / écartées). On tire un taux de
 * succès plausible par bras selon Beta(succès+1, échecs+1) et on retient le
 * maximum. Le +1 est la loi a priori uniforme : un bras jamais essayé tire
 * uniformément dans [0,1] et a donc une vraie chance de gagner — c'est ce qui
 * produit l'exploration, sans paramètre à régler.
 *
 * Renvoie -1 si la liste est vide.
 */
export function thompsonSample(
  arms: Array<{ successes: number; failures: number }>,
  random: () => number = Math.random,
): number {
  let bestIndex = -1;
  let bestDraw = -Infinity;

  for (let index = 0; index < arms.length; index++) {
    const arm = arms[index];
    const draw = sampleBeta(
      Math.max(0, arm.successes) + 1,
      Math.max(0, arm.failures) + 1,
      random,
    );
    if (draw > bestDraw) {
      bestDraw = draw;
      bestIndex = index;
    }
  }

  return bestIndex;
}

// ---------------------------------------------------------------------------
// 3. Composition du lot
// ---------------------------------------------------------------------------

export type ExploredCandidate = ScoredCandidate & {
  /** 0 = retenu pour sa pertinence, 1 = retenu pour la découverte. */
  exploration: number;
};

export type DiversifyOptions = {
  /** Taille du lot visée. */
  k?: number;
  lambda?: number;
  /** Part plancher d'exploration, dans [0,1]. */
  explorationRate?: number;
  maxPerArtist?: number;
  /**
   * Historique par famille de tags, alimenté depuis `recommendations` :
   * succès = noté 4-5, échec = ignoré ou écarté. Absent au démarrage, auquel cas
   * tous les bras partent d'une loi a priori uniforme.
   */
  armStats?: Map<string, Arm>;
  /** Regroupement en familles. Par défaut : le tag dominant du candidat. */
  armOf?: (candidate: ScoredCandidate) => string;
  /**
   * Morceaux à ne pas reproposer, typiquement ceux des derniers lots servis.
   * Complète `knownTrackIds`, qui ne couvre que ce qui a été réellement écouté.
   */
  excludeTrackIds?: Set<string>;
  /** Injectable pour rendre les tests déterministes. */
  random?: () => number;
};

/**
 * Compose le lot final : diversifié, sans doublon d'artiste, avec une part
 * garantie d'exploration.
 *
 * Renvoie moins de `k` éléments si le vivier ne permet pas de faire mieux sans
 * violer l'unicité par artiste — mieux vaut un lot court qu'un lot répétitif.
 */
export function diversifyAndExplore(
  scored: ScoredCandidate[],
  profile: TasteProfile,
  options: DiversifyOptions = {},
): ExploredCandidate[] {
  const {
    k = 20,
    lambda = DEFAULT_MMR_LAMBDA,
    explorationRate = DEFAULT_EXPLORATION_RATE,
    maxPerArtist = DEFAULT_MAX_PER_ARTIST,
    armStats,
    armOf = dominantTagArm,
    excludeTrackIds,
    random = Math.random,
  } = options;

  const pool = scored.filter(
    (item) =>
      !profile.knownTrackIds.has(item.trackId) &&
      !excludeTrackIds?.has(item.trackId),
  );

  if (k <= 0 || pool.length === 0) return [];

  const rate = clamp(explorationRate, 0, 1);
  const exploreTarget = Math.min(k, Math.ceil(k * rate));
  const exploitTarget = k - exploreTarget;

  const artistUsage = new Map<string, number>();
  const taken = new Set<string>();

  // --- Exploitation : les meilleurs, dédoublonnés par le MMR ---------------
  const ranked = [...pool].sort((a, b) => b.score - a.score);

  const mmrPool = ranked.slice(0, Math.max(k, k * MMR_POOL_FACTOR));
  // On demande plus de places que nécessaire : une partie des sélections sera
  // rejetée par l'unicité d'artiste, et on veut pouvoir puiser plus loin sans
  // relancer le MMR.
  const diversified = mmrRerank(
    mmrPool,
    Math.min(mmrPool.length, Math.max(exploitTarget * 3, exploitTarget)),
    lambda,
    candidateSimilarity,
  );

  const exploit: ExploredCandidate[] = [];
  for (const item of diversified) {
    if (exploit.length >= exploitTarget) break;
    if (!tryTake(item, artistUsage, taken, maxPerArtist)) continue;
    exploit.push({ ...item, exploration: 0 });
  }

  // --- Exploration : bandit sur les familles de tags -----------------------
  const explore = selectExploration({
    pool: ranked,
    target: exploreTarget,
    artistUsage,
    taken,
    maxPerArtist,
    armStats,
    armOf,
    random,
  });

  // Si l'exploration n'a pas pu se servir, on complète en exploitation plutôt
  // que de rendre un lot tronqué.
  if (explore.length < exploreTarget) {
    for (const item of diversified) {
      if (exploit.length + explore.length >= k) break;
      if (!tryTake(item, artistUsage, taken, maxPerArtist)) continue;
      exploit.push({ ...item, exploration: 0 });
    }
  }

  return interleave(exploit, explore);
}

/** Réserve un candidat si son artiste n'a pas atteint son quota. */
function tryTake(
  item: ScoredCandidate,
  artistUsage: Map<string, number>,
  taken: Set<string>,
  maxPerArtist: number,
): boolean {
  if (taken.has(item.trackId)) return false;

  const artistIds = item.candidate.artistIds;
  for (const artistId of artistIds) {
    if ((artistUsage.get(artistId) ?? 0) >= maxPerArtist) return false;
  }

  taken.add(item.trackId);
  for (const artistId of artistIds) {
    artistUsage.set(artistId, (artistUsage.get(artistId) ?? 0) + 1);
  }
  return true;
}

/** Famille par défaut : le tag de plus fort poids porté par le candidat. */
function dominantTagArm(item: ScoredCandidate): string {
  let best: WeightedTag | null = null;
  for (const tag of item.candidate.tags) {
    if (!best || tag.weight > best.weight) best = tag;
  }
  return best ? `tag:${best.tagId}` : "sans-tag";
}

function selectExploration(input: {
  pool: ScoredCandidate[];
  target: number;
  artistUsage: Map<string, number>;
  taken: Set<string>;
  maxPerArtist: number;
  armStats: Map<string, Arm> | undefined;
  armOf: (candidate: ScoredCandidate) => string;
  random: () => number;
}): ExploredCandidate[] {
  const { pool, target, artistUsage, taken, maxPerArtist, armStats, armOf, random } =
    input;

  if (target <= 0) return [];

  // Regroupement en familles. Le pool est déjà trié par score décroissant, donc
  // chaque famille l'est aussi.
  const families = new Map<string, ScoredCandidate[]>();
  for (const item of pool) {
    if (taken.has(item.trackId)) continue;
    const key = armOf(item);
    const list = families.get(key) ?? [];
    list.push(item);
    families.set(key, list);
  }

  const keys = [...families.keys()];
  if (keys.length === 0) return [];

  const arms = keys.map(
    (key) => armStats?.get(key) ?? { successes: 0, failures: 0 },
  );
  const exhausted = new Set<number>();
  const out: ExploredCandidate[] = [];

  while (out.length < target && exhausted.size < keys.length) {
    // Les bras épuisés sortent du tirage : leur laisser une probabilité
    // reviendrait à gaspiller des tours et à raccourcir le lot.
    const live = keys
      .map((_, index) => index)
      .filter((index) => !exhausted.has(index));

    let chosen: ScoredCandidate | null = null;

    for (let draw = 0; draw < MAX_ARM_DRAWS && chosen === null; draw++) {
      const armIndex = live[thompsonSample(live.map((i) => arms[i]), random)];
      if (armIndex === undefined) break;

      const members = families.get(keys[armIndex]) ?? [];
      // Au sein d'une famille, on privilégie les artistes jamais entendus :
      // c'est ce qui fait la différence entre « un autre morceau du même genre »
      // et une vraie découverte.
      const candidate =
        members.find(
          (item) =>
            item.reasons.nouveaute > 0 &&
            canTake(item, artistUsage, taken, maxPerArtist),
        ) ??
        members.find((item) => canTake(item, artistUsage, taken, maxPerArtist));

      if (!candidate) {
        exhausted.add(armIndex);
        continue;
      }
      chosen = candidate;
    }

    if (!chosen) break;

    tryTake(chosen, artistUsage, taken, maxPerArtist);
    out.push({ ...chosen, exploration: 1 });
  }

  return out;
}

function canTake(
  item: ScoredCandidate,
  artistUsage: Map<string, number>,
  taken: Set<string>,
  maxPerArtist: number,
): boolean {
  if (taken.has(item.trackId)) return false;
  return item.candidate.artistIds.every(
    (artistId) => (artistUsage.get(artistId) ?? 0) < maxPerArtist,
  );
}

/**
 * Répartit les découvertes régulièrement dans le lot.
 *
 * Les concentrer en fin de liste reviendrait à ne jamais les faire écouter :
 * une session s'interrompt bien avant la fin du lot, et l'exploration ne
 * remonterait alors aucun signal.
 */
function interleave(
  exploit: ExploredCandidate[],
  explore: ExploredCandidate[],
): ExploredCandidate[] {
  if (explore.length === 0) return exploit;
  if (exploit.length === 0) return explore;

  const total = exploit.length + explore.length;
  const positions = new Set<number>();

  for (let j = 0; j < explore.length; j++) {
    let position = Math.min(
      total - 1,
      Math.floor((j + 0.5) * (total / explore.length)),
    );
    while (positions.has(position)) position = (position + 1) % total;
    positions.add(position);
  }

  const ordered = [...positions].sort((a, b) => a - b);
  const out = new Array<ExploredCandidate>(total);

  ordered.forEach((position, index) => {
    out[position] = explore[index];
  });

  let next = 0;
  for (let i = 0; i < total; i++) {
    if (positions.has(i)) continue;
    out[i] = exploit[next++];
  }

  return out;
}
