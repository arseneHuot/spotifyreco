import { describe, expect, it } from "vitest";

/**
 * Test d'intégration du pipeline d'enrichissement, contre la vraie base et les
 * vraies API.
 *
 * Il vérifie ce qui bloquait la génération de recommandations : sans
 * caractéristiques audio ni tags, aucun morceau n'est classable et le moteur
 * renvoie un lot vide.
 *
 *   ROTATION_USER_ID=<uuid> npx vitest run \
 *     --config vitest.integration.config.ts src/test/enrich.integration.test.ts
 */

const { runEnrichment } = await import("@/lib/enrich/pipeline");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { buildTasteProfile } = await import("@/lib/reco/taste");

const USER_ID = process.env.ROTATION_USER_ID;

describe.skipIf(!USER_ID)("pipeline d'enrichissement", () => {
  it(
    "décrit les morceaux et élargit le vivier",
    async () => {
      const admin = createAdminClient();

      const before = await admin
        .from("track_features")
        .select("*", { count: "exact", head: true });

      const report = await runEnrichment(USER_ID!, { budgetMs: 200_000 });

      console.log("\n  ── Rapport d'enrichissement ──");
      console.log(`  caractéristiques ajoutées : ${report.featuresAdded}`);
      console.log(`  identifiants MusicBrainz  : ${report.mbidsResolved}`);
      console.log(`  tags ajoutés              : ${report.tagsAdded}`);
      console.log(`  tags Last.fm              : ${report.lastfmTagged}`);
      console.log(`  candidats ajoutés         : ${report.candidatesAdded}`);
      console.log(
        `  reste : ${report.remaining.withoutFeatures} sans caractéristiques, ${report.remaining.withoutMbid} sans MBID`,
      );
      for (const note of report.notes) console.log(`  note : ${note}`);

      const after = await admin
        .from("track_features")
        .select("*", { count: "exact", head: true });

      console.log(
        `  track_features : ${before.count ?? 0} → ${after.count ?? 0}`,
      );

      // Le pipeline doit produire quelque chose d'exploitable : sans
      // caractéristiques, la boucle de scoring n'a rien à classer.
      expect(after.count ?? 0).toBeGreaterThan(0);
    },
    300_000,
  );

  it("produit un profil de goût exploitable", async () => {
    const profile = await buildTasteProfile(USER_ID!);

    console.log("\n  ── Profil de goût ──");
    console.log(`  signaux            : ${profile.sampleSize}`);
    console.log(`  confiance          : ${profile.confidence.toFixed(2)}`);
    console.log(`  tags pondérés      : ${profile.tagWeights.size}`);
    console.log(`  artistes pondérés  : ${profile.artistWeights.size}`);
    console.log(`  morceaux connus    : ${profile.knownTrackIds.size}`);
    console.log(
      `  centroïde features : ${profile.featureCentroid ? "calculé" : "absent"}`,
    );

    expect(profile.sampleSize).toBeGreaterThan(0);
  }, 120_000);
});
