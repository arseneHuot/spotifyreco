import { afterAll, describe, expect, it } from "vitest";

/**
 * Tests d'intégration : ils appellent les vraies API externes et écrivent dans
 * la vraie base Supabase.
 *
 * Exclus de `npm test` (voir `vitest.config.ts`) parce qu'ils dépendent du
 * réseau et de secrets. À lancer explicitement :
 *
 *   npx vitest run --config vitest.integration.config.ts
 *
 * Toutes les lignes créées portent le préfixe `__it__` et sont supprimées en
 * fin de suite.
 */

const PREFIX = "__it__";

// Daft Punk — One More Time. Choisi parce qu'il est présent dans les trois
// catalogues (Spotify, ReccoBeats, MusicBrainz), ce qui isole les échecs
// réseau des échecs de couverture.
const TRACK_ID = "0DiWol3AO6WpXZgp0goxAV";
const ISRC = "GBDUW0000053";

const { createAdminClient } = await import("@/lib/supabase/admin");
const { fetchAudioFeatures, enrichTracksWithFeatures } = await import(
  "@/lib/enrich/reccobeats"
);
const { resolveIsrcToRecording, fetchRecordingGenres } = await import(
  "@/lib/enrich/musicbrainz"
);
const { fetchSimilarRecordings, SIMILAR_RECORDINGS_ALGORITHMS } = await import(
  "@/lib/enrich/listenbrainz"
);

const admin = createAdminClient();

afterAll(async () => {
  await admin.from("track_features").delete().eq("track_id", TRACK_ID);
  await admin.from("track_tags").delete().eq("track_id", TRACK_ID);
  await admin.from("tracks").delete().like("id", `${PREFIX}%`);
  await admin.from("tracks").delete().eq("id", TRACK_ID);
  await admin.from("artists").delete().like("id", `${PREFIX}%`);
});

describe("ReccoBeats", () => {
  it("renvoie des caractéristiques indexées par identifiant Spotify", async () => {
    const features = await fetchAudioFeatures([TRACK_ID]);

    const track = features.get(TRACK_ID);
    expect(track).toBeDefined();

    // Les valeurs doivent respecter les échelles de l'ancienne API Spotify,
    // sur lesquelles le moteur de scoring est calibré.
    expect(track!.danceability).toBeGreaterThan(0);
    expect(track!.danceability).toBeLessThanOrEqual(1);
    expect(track!.tempo).toBeGreaterThan(50);
    expect(track!.key).toBeGreaterThanOrEqual(0);
    expect(track!.key).toBeLessThanOrEqual(11);
  }, 30_000);

  it("omet les identifiants inconnus sans décaler les autres", async () => {
    // Le point critique : la réponse n'est pas ordonnée comme la requête, donc
    // tout appariement par position serait faux.
    const features = await fetchAudioFeatures([
      "0000000000000000000000",
      TRACK_ID,
    ]);

    expect(features.has(TRACK_ID)).toBe(true);
    expect(features.has("0000000000000000000000")).toBe(false);
  }, 30_000);

  it("écrit réellement en base", async () => {
    await admin
      .from("tracks")
      .upsert({ id: TRACK_ID, name: "One More Time", isrc: ISRC });

    const result = await enrichTracksWithFeatures([TRACK_ID]);
    expect(result.enriched).toBeGreaterThanOrEqual(0);

    const { data } = await admin
      .from("track_features")
      .select("track_id, energy, tempo")
      .eq("track_id", TRACK_ID)
      .maybeSingle();

    expect(data).not.toBeNull();
    expect(data!.energy).toBeGreaterThan(0);
  }, 60_000);
});

describe("MusicBrainz", () => {
  it("résout un ISRC vers un enregistrement", async () => {
    const recording = await resolveIsrcToRecording(ISRC);

    expect(recording).not.toBeNull();
    expect(recording!.mbid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  }, 30_000);

  it("renvoie null sur un ISRC inconnu au lieu de lever", async () => {
    expect(await resolveIsrcToRecording("ZZZZZ0000000")).toBeNull();
  }, 30_000);

  it("récupère des genres pour un enregistrement connu", async () => {
    const recording = await resolveIsrcToRecording(ISRC);
    const genres = await fetchRecordingGenres(recording!.mbid);

    expect(Array.isArray(genres)).toBe(true);
    for (const genre of genres) {
      expect(typeof genre.name).toBe("string");
      expect(genre.count).toBeGreaterThanOrEqual(0);
    }
  }, 45_000);
});

describe("ListenBrainz", () => {
  it("expose des algorithmes valides", () => {
    expect(SIMILAR_RECORDINGS_ALGORITHMS.length).toBeGreaterThan(0);
    // Le piège documenté : les algorithmes de similar-artists ne sont pas
    // acceptés par similar-recordings et provoquent un HTTP 400.
    for (const algorithm of SIMILAR_RECORDINGS_ALGORITHMS) {
      expect(algorithm).not.toContain("filter_True");
    }
  });

  it("ne lève pas sur un MBID absent du jeu de données", async () => {
    const results = await fetchSimilarRecordings(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(Array.isArray(results)).toBe(true);
  }, 30_000);
});
