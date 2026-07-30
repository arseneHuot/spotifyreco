import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPLORATION_RATE,
  candidateSimilarity,
  diversifyAndExplore,
  mmrRerank,
  sampleBeta,
  thompsonSample,
  type Arm,
} from "@/lib/reco/diversity";
import type { ScoredCandidate } from "@/lib/reco/scoring";
import type { TasteProfile } from "@/lib/reco/taste";

// ---------------------------------------------------------------------------
// Utilitaires de test
// ---------------------------------------------------------------------------

/**
 * Générateur déterministe (mulberry32).
 *
 * Les tirages Beta et le bandit sont stochastiques : sans graine fixe, un test
 * qui passe neuf fois sur dix est un test qui ment.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCandidate(
  trackId: string,
  artistId: string,
  tagIds: number[],
  score: number,
  novelty = 1,
): ScoredCandidate {
  return {
    trackId,
    score,
    reasons: {
      affiniteTags: score,
      affiniteArtiste: 0,
      proximiteFeatures: 0,
      nouveaute: novelty,
      penaliteNegative: 0,
      total: score,
    },
    candidate: {
      trackId,
      artistIds: [artistId],
      tags: tagIds.map((tagId) => ({ tagId, weight: 1 })),
      features: null,
    },
  };
}

function emptyProfile(): TasteProfile {
  return {
    tagWeights: new Map(),
    rejectedTagWeights: new Map(),
    artistWeights: new Map(),
    featureCentroid: null,
    featureSpread: null,
    knownTrackIds: new Set(),
    knownArtistIds: new Set(),
    sampleSize: 0,
    confidence: 0,
  };
}

/** 40 candidats, 40 artistes distincts, 8 familles de tags, scores décroissants. */
function makePool(size = 40): ScoredCandidate[] {
  return Array.from({ length: size }, (_, i) =>
    makeCandidate(`t${i}`, `a${i}`, [i % 8], 1 - i / size),
  );
}

// ---------------------------------------------------------------------------

describe("mmrRerank", () => {
  const items = [
    makeCandidate("A", "artA", [1], 1),
    makeCandidate("A-bis", "artB", [1], 0.98), // quasi-doublon de A
    makeCandidate("B", "artC", [2], 0.9),
    makeCandidate("C", "artD", [3], 0.2),
  ];

  it("écarte le quasi-doublon au profit d'un morceau différent", () => {
    const picked = mmrRerank(items, 2, 0.7, candidateSimilarity).map(
      (i) => i.trackId,
    );

    expect(picked[0]).toBe("A");
    // A-bis partage le tag de A : sa pertinence marginale s'effondre.
    expect(picked).not.toContain("A-bis");
    expect(picked[1]).toBe("B");
  });

  it("retombe sur le classement par score quand lambda vaut 1", () => {
    const picked = mmrRerank(items, 3, 1, candidateSimilarity).map(
      (i) => i.trackId,
    );

    expect(picked).toEqual(["A", "A-bis", "B"]);
  });

  it("privilégie la dissemblance quand lambda vaut 0", () => {
    const picked = mmrRerank(items, 2, 0, candidateSimilarity).map(
      (i) => i.trackId,
    );

    // Le premier choix est arbitraire (toutes les pertinences sont neutralisées),
    // mais le second ne doit jamais partager de tag avec lui.
    const first = items.find((i) => i.trackId === picked[0])!;
    const second = items.find((i) => i.trackId === picked[1])!;
    expect(candidateSimilarity(first, second)).toBe(0);
  });

  it("accepte une fonction de pertinence explicite", () => {
    // Pertinence inversée : le dernier du classement par score doit sortir premier.
    const picked = mmrRerank(items, 1, 1, candidateSimilarity, (i) => -i.score);
    expect(picked[0].trackId).toBe("C");
  });

  it("ne renvoie jamais plus d'éléments qu'il n'en reçoit", () => {
    expect(mmrRerank(items, 99, 0.7, candidateSimilarity)).toHaveLength(4);
    expect(mmrRerank([], 5, 0.7, candidateSimilarity)).toHaveLength(0);
    expect(mmrRerank(items, 0, 0.7, candidateSimilarity)).toHaveLength(0);
  });

  it("ne boucle pas quand tous les scores sont identiques", () => {
    const flat = [
      makeCandidate("x", "ax", [1], 0.5),
      makeCandidate("y", "ay", [2], 0.5),
      makeCandidate("z", "az", [3], 0.5),
    ];
    expect(mmrRerank(flat, 3, 0.7, candidateSimilarity)).toHaveLength(3);
  });
});

describe("candidateSimilarity", () => {
  it("considère deux morceaux du même artiste comme identiques", () => {
    const a = makeCandidate("a", "meme", [1], 1);
    const b = makeCandidate("b", "meme", [42], 1); // tags pourtant disjoints
    expect(candidateSimilarity(a, b)).toBe(1);
  });

  it("renvoie 0 pour des tags disjoints et 1 pour des tags identiques", () => {
    const a = makeCandidate("a", "a1", [1, 2], 1);
    const b = makeCandidate("b", "a2", [3, 4], 1);
    const c = makeCandidate("c", "a3", [1, 2], 1);

    expect(candidateSimilarity(a, b)).toBe(0);
    expect(candidateSimilarity(a, c)).toBeCloseTo(1, 10);
  });

  it("ne traite pas un morceau sans tag comme maximalement diversifiant", () => {
    const tagged = makeCandidate("a", "a1", [1], 1);
    const untagged = makeCandidate("b", "a2", [], 1);

    // Une similarité de 0 ferait des morceaux non enrichis les favoris du MMR.
    expect(candidateSimilarity(tagged, untagged)).toBeGreaterThan(0);
  });
});

describe("sampleBeta", () => {
  it("reste dans [0,1] sur tout l'espace des paramètres", () => {
    const random = seededRandom(1);
    const cases: Array<[number, number]> = [
      [1, 1],
      [0.2, 0.3],
      [1, 500],
      [500, 1],
      [1000, 1000],
    ];

    for (const [alpha, beta] of cases) {
      for (let i = 0; i < 500; i++) {
        const draw = sampleBeta(alpha, beta, random);
        expect(Number.isFinite(draw)).toBe(true);
        expect(draw).toBeGreaterThanOrEqual(0);
        expect(draw).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a pour moyenne successes/(successes+failures) sur un grand échantillon", () => {
    const random = seededRandom(7);
    const successes = 300;
    const failures = 100;

    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      sum += sampleBeta(successes + 1, failures + 1, random);
    }

    expect(sum / n).toBeCloseTo(successes / (successes + failures), 2);
  });

  it("suit exactement la moyenne théorique Beta(a,b) = a/(a+b)", () => {
    const random = seededRandom(11);

    // À faible effectif, la loi a priori uniforme (+1) décale volontairement la
    // moyenne empirique : c'est elle qui crée l'exploration, et c'est donc la
    // moyenne de Beta(s+1, f+1) qui fait foi, pas s/(s+f).
    for (const [successes, failures] of [
      [1, 9],
      [0, 0],
      [5, 5],
    ]) {
      const alpha = successes + 1;
      const beta = failures + 1;

      let sum = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) sum += sampleBeta(alpha, beta, random);

      expect(sum / n).toBeCloseTo(alpha / (alpha + beta), 2);
    }
  });

  it("a une variance décroissante à mesure que les observations s'accumulent", () => {
    const random = seededRandom(3);

    const spread = (alpha: number, beta: number): number => {
      const draws = Array.from({ length: 4000 }, () =>
        sampleBeta(alpha, beta, random),
      );
      const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
      return Math.sqrt(
        draws.reduce((acc, d) => acc + (d - mean) ** 2, 0) / draws.length,
      );
    };

    // Un bras jamais essayé doit être très incertain, un bras rodé très sûr.
    expect(spread(1, 1)).toBeGreaterThan(spread(301, 101));
  });
});

describe("thompsonSample", () => {
  it("renvoie -1 sur une liste vide", () => {
    expect(thompsonSample([], seededRandom(1))).toBe(-1);
  });

  it("converge sur le meilleur bras quand les historiques sont tranchés", () => {
    const random = seededRandom(42);
    const arms: Arm[] = [
      { successes: 2, failures: 40 },
      { successes: 40, failures: 2 },
      { successes: 5, failures: 20 },
    ];

    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[thompsonSample(arms, random)]++;

    // Les lois a posteriori ne se recouvrent quasiment plus (0,07 / 0,93 / 0,22) :
    // l'incertitude est levée, et un bandit correct cesse alors d'explorer. C'est
    // le quota plancher de `diversifyAndExplore`, pas le bandit, qui garantit la
    // variété dans ce régime.
    expect(counts[1]).toBeGreaterThan(0.95 * 3000);
  });

  it("continue d'explorer tant que les preuves sont minces", () => {
    const random = seededRandom(42);
    const arms: Arm[] = [
      { successes: 8, failures: 12 },
      { successes: 12, failures: 8 },
      { successes: 0, failures: 0 },
    ];

    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) counts[thompsonSample(arms, random)]++;

    // Le bras 1 domine, mais aucun n'est écarté — le bras jamais essayé
    // décroche même une part importante des tours.
    expect(counts[1]).toBeGreaterThan(counts[0]);
    for (const count of counts) expect(count).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(3000 * 0.15);
  });

  it("explore uniformément quand aucun bras n'a d'historique", () => {
    const random = seededRandom(5);
    const arms: Arm[] = Array.from({ length: 4 }, () => ({
      successes: 0,
      failures: 0,
    }));

    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) counts[thompsonSample(arms, random)]++;

    for (const count of counts) {
      expect(count).toBeGreaterThan(4000 / 4 / 2);
    }
  });
});

describe("diversifyAndExplore", () => {
  it("respecte le quota plancher d'exploration", () => {
    const batch = diversifyAndExplore(makePool(), emptyProfile(), {
      k: 20,
      random: seededRandom(9),
    });

    const explored = batch.filter((item) => item.exploration === 1);

    expect(batch).toHaveLength(20);
    expect(explored.length).toBeGreaterThanOrEqual(
      Math.ceil(20 * DEFAULT_EXPLORATION_RATE),
    );
  });

  it("respecte un taux d'exploration relevé", () => {
    const batch = diversifyAndExplore(makePool(60), emptyProfile(), {
      k: 20,
      explorationRate: 0.5,
      random: seededRandom(4),
    });

    const explored = batch.filter((item) => item.exploration === 1);
    expect(explored.length).toBeGreaterThanOrEqual(10);
  });

  it("explore même quand le profil est très marqué", () => {
    // Quelques candidats écrasent tous les autres : sans quota, le lot entier
    // viendrait de la même veine.
    const pool = makePool(40).map((item, i) =>
      i < 5 ? { ...item, score: 10 } : item,
    );

    const batch = diversifyAndExplore(pool, emptyProfile(), {
      k: 12,
      random: seededRandom(21),
    });

    expect(batch.filter((i) => i.exploration === 1).length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("ne propose jamais deux fois le même artiste dans un lot", () => {
    // Cinq artistes seulement, chacun avec huit morceaux : le piège classique.
    const pool = Array.from({ length: 40 }, (_, i) =>
      makeCandidate(`t${i}`, `artiste${i % 5}`, [i % 3], 1 - i / 40),
    );

    const batch = diversifyAndExplore(pool, emptyProfile(), {
      k: 20,
      random: seededRandom(13),
    });

    const artistIds = batch.flatMap((item) => item.candidate.artistIds);
    expect(new Set(artistIds).size).toBe(artistIds.length);
    // Un lot court vaut mieux qu'un lot répétitif.
    expect(batch).toHaveLength(5);
  });

  it("ne renvoie aucun doublon de morceau", () => {
    const batch = diversifyAndExplore(makePool(50), emptyProfile(), {
      k: 25,
      random: seededRandom(77),
    });

    const ids = batch.map((item) => item.trackId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exclut les morceaux déjà connus et ceux des lots précédents", () => {
    const profile = emptyProfile();
    profile.knownTrackIds.add("t0");
    profile.knownTrackIds.add("t1");

    const batch = diversifyAndExplore(makePool(), profile, {
      k: 10,
      excludeTrackIds: new Set(["t2", "t3"]),
      random: seededRandom(8),
    });

    const ids = batch.map((item) => item.trackId);
    for (const excluded of ["t0", "t1", "t2", "t3"]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("répartit les découvertes dans le lot plutôt que de les reléguer à la fin", () => {
    const batch = diversifyAndExplore(makePool(), emptyProfile(), {
      k: 20,
      random: seededRandom(31),
    });

    const positions = batch
      .map((item, index) => (item.exploration === 1 ? index : -1))
      .filter((index) => index >= 0);

    // Au moins une découverte dans la première moitié : reléguées en fin de
    // liste, elles ne seraient jamais écoutées et ne renverraient aucun signal.
    expect(positions.some((p) => p < 10)).toBe(true);
    expect(positions[0]).toBeLessThan(batch.length - 1);
  });

  it("suit l'historique des bras quand il est fourni", () => {
    // Deux familles : la 7 a un historique excellent, les autres sont mauvaises.
    const pool = Array.from({ length: 40 }, (_, i) =>
      makeCandidate(`t${i}`, `a${i}`, [i % 8], 0.5),
    );

    const armStats = new Map<string, Arm>();
    for (let tagId = 0; tagId < 8; tagId++) {
      armStats.set(
        `tag:${tagId}`,
        tagId === 7
          ? { successes: 80, failures: 2 }
          : { successes: 1, failures: 60 },
      );
    }

    const batch = diversifyAndExplore(pool, emptyProfile(), {
      k: 8,
      explorationRate: 1, // tout le lot passe par le bandit
      armStats,
      random: seededRandom(17),
    });

    const fromWinningArm = batch.filter((item) =>
      item.candidate.tags.some((tag) => tag.tagId === 7),
    );

    expect(fromWinningArm.length).toBeGreaterThan(batch.length / 8);
  });

  it("gère les cas dégénérés sans planter", () => {
    expect(diversifyAndExplore([], emptyProfile(), { k: 10 })).toEqual([]);
    expect(diversifyAndExplore(makePool(), emptyProfile(), { k: 0 })).toEqual([]);

    const single = diversifyAndExplore(makePool(1), emptyProfile(), {
      k: 10,
      random: seededRandom(2),
    });
    expect(single).toHaveLength(1);
  });

  it("autorise plusieurs morceaux par artiste si on le demande explicitement", () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(`t${i}`, `artiste${i % 4}`, [i % 3], 1 - i / 20),
    );

    const batch = diversifyAndExplore(pool, emptyProfile(), {
      k: 8,
      maxPerArtist: 2,
      random: seededRandom(6),
    });

    expect(batch).toHaveLength(8);

    const counts = new Map<string, number>();
    for (const item of batch) {
      for (const artistId of item.candidate.artistIds) {
        counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
      }
    }
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(2);
  });
});
