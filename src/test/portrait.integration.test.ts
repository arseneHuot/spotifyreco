import { describe, expect, it } from "vitest";

/**
 * Diagnostic : que reçoit exactement le modèle pour décrire les goûts ?
 *
 * Quand les suggestions tombent à côté, la cause est presque toujours en amont
 * du modèle — un portrait trop pauvre produit des propositions génériques.
 *
 *   ROTATION_USER_ID=<uuid> npx vitest run \
 *     --config vitest.integration.config.ts src/test/portrait.integration.test.ts
 */

const { buildTasteProfile } = await import("@/lib/reco/taste");
const { createAdminClient } = await import("@/lib/supabase/admin");

const USER_ID = process.env.ROTATION_USER_ID;

describe.skipIf(!USER_ID)("portrait transmis au modèle", () => {
  it("montre le signal réellement disponible", async () => {
    const admin = createAdminClient();
    const profile = await buildTasteProfile(USER_ID!);

    console.log("\n  ── Profil brut ──");
    console.log(`  signaux           : ${profile.sampleSize}`);
    console.log(`  confiance         : ${profile.confidence.toFixed(2)}`);
    console.log(`  tags pondérés     : ${profile.tagWeights.size}`);
    console.log(`  tags rejetés      : ${profile.rejectedTagWeights.size}`);
    console.log(`  artistes pondérés : ${profile.artistWeights.size}`);
    console.log(`  centroïde audio   : ${profile.featureCentroid ? "oui" : "NON"}`);

    // --- Ce qui passe réellement le filtre du portrait -----------------------
    const topArtistIds = [...profile.artistWeights.entries()]
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([id]) => id);

    const { data: withMbid } = await admin
      .from("artists")
      .select("name")
      .in("id", topArtistIds)
      .not("mb_artist_mbid", "is", null);

    const { data: allTop } = await admin
      .from("artists")
      .select("name")
      .in("id", topArtistIds);

    console.log("\n  ── Filtre « artistes résolus MusicBrainz » ──");
    console.log(`  artistes candidats        : ${allTop?.length ?? 0}`);
    console.log(`  → transmis au modèle      : ${withMbid?.length ?? 0}`);
    if ((allTop?.length ?? 0) > 0) {
      console.log(
        `  exemples écartés : ${(allTop ?? [])
          .slice(0, 8)
          .map((a) => a.name)
          .join(", ")}`,
      );
    }

    const tagIds = [...profile.tagWeights.entries()]
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id]) => id);

    const { data: tagRows } = await admin
      .from("tags")
      .select("name, source")
      .in("id", tagIds);

    console.log("\n  ── Tags transmis ──");
    console.log(`  ${(tagRows ?? []).map((t) => t.name).join(", ") || "AUCUN"}`);

    expect(profile.sampleSize).toBeGreaterThan(0);
  }, 120_000);
});
