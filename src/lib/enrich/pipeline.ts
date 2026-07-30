import "server-only";

import { enrichArtistsFromLastfm } from "@/lib/enrich/lastfm";
import { fetchSimilarRecordings } from "@/lib/enrich/listenbrainz";
import { enrichTracksFromMusicBrainz } from "@/lib/enrich/musicbrainz";
import { enrichTracksWithFeatures } from "@/lib/enrich/reccobeats";
import { upsertTracks } from "@/lib/spotify/catalog";
import { spotifyFetch } from "@/lib/spotify/client";

/**
 * Plafond de recherches Spotify par passage d'enrichissement.
 *
 * L'expansion tournait chaque heure bornée par le temps seulement : jusqu'à
 * cent recherches par passage, deux mille quatre cents par jour — en tâche de
 * fond, sans que l'utilisateur ne fasse rien. Sur un quota décompté par
 * application, c'est l'enrichissement qui vidait le réservoir des générations
 * et de la lecture. Douze par heure suffisent : le catalogue grandit chaque
 * jour, personne n'attend derrière.
 */
const EXPANSION_SEARCH_BUDGET = 12;
import type { SpotifyTrack } from "@/lib/spotify/types";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Enrichissement du catalogue et élargissement du vivier de candidats.
 *
 * Sans cette étape, le moteur ne peut rien produire : un morceau sans
 * descripteur n'est pas classable, et un catalogue limité à ce que
 * l'utilisateur a déjà écouté ne contient par définition aucune découverte.
 *
 * Aucune source utilisée ici n'exige de clé d'API. Last.fm améliore nettement
 * le résultat mais reste facultatif — le pipeline complet fonctionne sans lui,
 * par ReccoBeats (caractéristiques audio), MusicBrainz (identité et genres) et
 * ListenBrainz (similarité issue d'écoutes réelles).
 *
 * Le travail est **incrémental** : chaque passage traite ce qui reste dans le
 * temps imparti. Les fonctions serverless sont coupées à 300 secondes, et
 * MusicBrainz impose une requête par seconde — enrichir des centaines de
 * morceaux d'un seul tenant est impossible par construction.
 */

/** Marge conservée pour que la réponse HTTP parte avant la coupure. */
const SAFETY_MARGIN_MS = 20_000;

export type EnrichmentReport = {
  featuresAdded: number;
  mbidsResolved: number;
  tagsAdded: number;
  lastfmTagged: number;
  candidatesAdded: number;
  remaining: { withoutFeatures: number; withoutMbid: number };
  notes: string[];
};

export async function runEnrichment(
  userId: string,
  { budgetMs = 240_000 }: { budgetMs?: number } = {},
): Promise<EnrichmentReport> {
  const deadline = Date.now() + budgetMs - SAFETY_MARGIN_MS;
  const admin = createAdminClient();
  const notes: string[] = [];

  const report: EnrichmentReport = {
    featuresAdded: 0,
    mbidsResolved: 0,
    tagsAdded: 0,
    lastfmTagged: 0,
    candidatesAdded: 0,
    remaining: { withoutFeatures: 0, withoutMbid: 0 },
    notes,
  };

  // ── 1. Caractéristiques audio ──────────────────────────────────────────────
  // En premier parce que c'est le plus rentable : 40 morceaux par requête, et
  // c'est ce qui rend un morceau scorable.
  const { data: needFeatures } = await admin
    .from("tracks")
    .select("id, track_features(track_id)")
    .limit(400);

  const missingFeatures = (needFeatures ?? [])
    .filter((t) => {
      const f = t.track_features;
      return Array.isArray(f) ? f.length === 0 : !f;
    })
    .map((t) => t.id);

  if (missingFeatures.length > 0) {
    try {
      const result = await enrichTracksWithFeatures(missingFeatures);
      report.featuresAdded = result.enriched;

      if (result.missing.length > 0) {
        // Un lot entièrement manquant ne veut pas dire que ces morceaux sont
        // inconnus du catalogue : le service peut être hors ligne. Confondre
        // les deux envoie sur une fausse piste, alors on vérifie.
        const reachable =
          result.enriched > 0 || (await isReccoBeatsReachable());

        notes.push(
          reachable
            ? `${result.missing.length} track(s) missing from the ReccoBeats catalogue.`
            : "ReccoBeats is currently offline — audio features will be missing until the service is back. The engine can run on tags alone.",
        );
      }
    } catch (cause) {
      notes.push(
        `ReccoBeats injoignable : ${cause instanceof Error ? cause.message : "erreur"}`,
      );
    }
  }

  // ── 2. Identité MusicBrainz ───────────────────────────────────────────────
  // Deux requêtes par morceau à une par seconde : c'est le goulot du pipeline.
  // On s'arrête à l'échéance et on reprendra au passage suivant.
  if (Date.now() < deadline) {
    const { data: needMbid } = await admin
      .from("tracks")
      .select("id")
      .not("isrc", "is", null)
      .is("mb_recording_mbid", null)
      .limit(200);

    const ids = (needMbid ?? []).map((t) => t.id);
    if (ids.length > 0) {
      try {
        const result = await enrichTracksFromMusicBrainz(ids, {
          deadlineMs: Math.max(0, deadline - Date.now()) * 0.6,
        });
        report.mbidsResolved = result.resolved;
        report.tagsAdded = result.tagged;
      } catch (cause) {
        notes.push(
          `MusicBrainz indisponible : ${cause instanceof Error ? cause.message : "erreur"}`,
        );
      }
    }
  }

  // ── 3. Tags Last.fm, si une clé est configurée ────────────────────────────
  if (env().LASTFM_API_KEY && Date.now() < deadline) {
    const { data: artists } = await admin
      .from("artists")
      .select("id")
      .is("enriched_at", null)
      .limit(40);

    const artistIds = (artists ?? []).map((a) => a.id);
    if (artistIds.length > 0) {
      try {
        const result = await enrichArtistsFromLastfm(artistIds);
        report.lastfmTagged = result.tagged;
      } catch (cause) {
        notes.push(
          `Last.fm indisponible : ${cause instanceof Error ? cause.message : "erreur"}`,
        );
      }
    }
  } else if (!env().LASTFM_API_KEY) {
    notes.push(
      "Without a Last.fm key, tags are limited to MusicBrainz genres — noticeably thinner.",
    );
  }

  // ── 4. Élargir le vivier ──────────────────────────────────────────────────
  if (Date.now() < deadline) {
    report.candidatesAdded = await expandFromListenBrainz(userId, deadline);
  }

  // ── 5. Ce qu'il reste à faire ─────────────────────────────────────────────
  const [{ count: withoutFeatures }, { count: withoutMbid }] = await Promise.all(
    [
      admin
        .from("tracks")
        .select("id, track_features!left(track_id)", {
          count: "exact",
          head: true,
        })
        .is("track_features.track_id", null),
      admin
        .from("tracks")
        .select("*", { count: "exact", head: true })
        .not("isrc", "is", null)
        .is("mb_recording_mbid", null),
    ],
  );

  report.remaining = {
    withoutFeatures: withoutFeatures ?? 0,
    withoutMbid: withoutMbid ?? 0,
  };

  return report;
}

/**
 * Vérifie que ReccoBeats répond, pour distinguer « morceau inconnu du
 * catalogue » de « service hors ligne ».
 *
 * Le service est passé plusieurs fois par des interruptions (erreur 530 via
 * Cloudflare) : sans ce contrôle, une panne se présente comme une absence de
 * données, et on cherche le problème du mauvais côté.
 */
async function isReccoBeatsReachable(): Promise<boolean> {
  try {
    // Un morceau très largement référencé : s'il ne remonte pas, ce n'est pas
    // une question de couverture du catalogue.
    const response = await fetch(
      "https://api.reccobeats.com/v1/audio-features?ids=0DiWol3AO6WpXZgp0goxAV",
      { cache: "no-store", signal: AbortSignal.timeout(8000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ajoute au catalogue des morceaux voisins de ceux que l'utilisateur apprécie.
 *
 * ListenBrainz calcule ses similarités sur des millions d'écoutes réelles et
 * répond en MBID accompagnés du titre et de l'artiste — ce qui permet de
 * retrouver le morceau sur Spotify sans repasser par MusicBrainz, et donc sans
 * subir sa limite d'une requête par seconde.
 */
async function expandFromListenBrainz(
  userId: string,
  deadline: number,
): Promise<number> {
  const admin = createAdminClient();

  // On part des morceaux les mieux notés, puis des likes : ce sont les points
  // d'ancrage les plus fiables du goût.
  const { data: rated } = await admin
    .from("ratings")
    .select("track_id, rating")
    .eq("user_id", userId)
    .gte("rating", 4)
    .limit(30);

  const { data: saved } = await admin
    .from("saved_tracks")
    .select("track_id")
    .eq("user_id", userId)
    .limit(60);

  const seedIds = [
    ...new Set([
      ...(rated ?? []).map((r) => r.track_id),
      ...(saved ?? []).map((s) => s.track_id),
    ]),
  ];

  if (seedIds.length === 0) return 0;

  const { data: seeds } = await admin
    .from("tracks")
    .select("id, mb_recording_mbid")
    .in("id", seedIds)
    .not("mb_recording_mbid", "is", null)
    .limit(25);

  if (!seeds?.length) return 0;

  // Ce que l'utilisateur connaît déjà : le proposer ne serait pas une découverte.
  const { data: known } = await admin
    .from("listens")
    .select("track_id")
    .eq("user_id", userId)
    .limit(2000);

  const knownIds = new Set([
    ...(known ?? []).map((l) => l.track_id),
    ...seedIds,
  ]);

  const seenQueries = new Set<string>();
  let added = 0;
  let searches = 0;

  for (const seed of seeds) {
    if (searches >= EXPANSION_SEARCH_BUDGET) break;
    if (Date.now() > deadline) break;

    let similar: Awaited<ReturnType<typeof fetchSimilarRecordings>> = [];
    try {
      similar = await fetchSimilarRecordings(seed.mb_recording_mbid!);
    } catch {
      continue;
    }

    // Les meilleurs voisins de chaque graine, pour varier les origines plutôt
    // que d'épuiser le budget sur une seule.
    for (const candidate of similar.slice(0, 4)) {
      if (Date.now() > deadline) break;
      if (!candidate.name || !candidate.artist) continue;

      const key = `${candidate.artist}::${candidate.name}`.toLowerCase();
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);

      if (searches >= EXPANSION_SEARCH_BUDGET) break;
      searches++;

      try {
        const found = await spotifyFetch<{ tracks?: { items?: SpotifyTrack[] } }>(
          userId,
          `/search?q=${encodeURIComponent(`track:${candidate.name} artist:${candidate.artist}`)}&type=track&limit=1`,
        );

        const track = found?.tracks?.items?.[0];
        if (!track?.id || knownIds.has(track.id)) continue;

        await upsertTracks([track]);
        knownIds.add(track.id);
        added++;
      } catch {
        // Quota Spotify épuisé ou recherche infructueuse : on arrête
        // l'élargissement, le reste du pipeline garde sa valeur.
        return added;
      }
    }
  }

  // Les nouveaux venus doivent être décrits pour devenir scorables.
  if (added > 0) {
    const { data: fresh } = await admin
      .from("tracks")
      .select("id, track_features(track_id)")
      .limit(400);

    const toEnrich = (fresh ?? [])
      .filter((t) => {
        const f = t.track_features;
        return Array.isArray(f) ? f.length === 0 : !f;
      })
      .map((t) => t.id);

    if (toEnrich.length > 0) {
      await enrichTracksWithFeatures(toEnrich).catch(() => undefined);
    }
  }

  return added;
}
