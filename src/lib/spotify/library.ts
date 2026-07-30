import "server-only";

import { upsertTracks } from "@/lib/spotify/catalog";
import { spotifyFetch, spotifyPaginate } from "@/lib/spotify/client";
import type {
  SpotifyArtist,
  SpotifySavedTrack,
  SpotifyTrack,
} from "@/lib/spotify/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Enums } from "@/lib/supabase/database.types";

/**
 * Synchronise les morceaux likés.
 *
 * Un like est le signal explicite le plus fiable dont on dispose avant que
 * l'utilisateur n'ait noté quoi que ce soit : il sert d'amorce au moteur.
 */
export async function syncSavedTracks(
  userId: string,
  { maxItems = 2000 }: { maxItems?: number } = {},
): Promise<number> {
  const saved = await spotifyPaginate<SpotifySavedTrack>(
    userId,
    "/me/tracks",
    { maxItems },
  );

  const withTrack = saved.filter((item) => item?.track?.id);
  if (withTrack.length === 0) return 0;

  await upsertTracks(withTrack.map((item) => item.track));

  const admin = createAdminClient();
  const { error } = await admin.from("saved_tracks").upsert(
    withTrack.map((item) => ({
      user_id: userId,
      track_id: item.track.id,
      added_at: item.added_at,
    })),
    { onConflict: "user_id,track_id", ignoreDuplicates: true },
  );

  if (error) throw new Error(`upsert saved_tracks : ${error.message}`);
  return withTrack.length;
}

const TIME_RANGES: Enums<"top_time_range">[] = [
  "short_term",
  "medium_term",
  "long_term",
];

/**
 * Capture les classements personnels sur les trois fenêtres temporelles.
 *
 * Les trois fenêtres comptent : l'écart entre `short_term` et `long_term` dit
 * si un artiste est une découverte du moment ou un fond de catalogue, ce qui
 * pondère différemment les recommandations.
 */
export async function syncTopItems(userId: string): Promise<number> {
  const admin = createAdminClient();
  let total = 0;

  for (const timeRange of TIME_RANGES) {
    // --- Morceaux -----------------------------------------------------------
    const topTracks = await spotifyFetch<{ items: SpotifyTrack[] }>(
      userId,
      `/me/top/tracks?time_range=${timeRange}&limit=50`,
    );

    if (topTracks?.items?.length) {
      await upsertTracks(topTracks.items);

      const { error } = await admin.from("top_items").upsert(
        topTracks.items.map((track, index) => ({
          user_id: userId,
          entity_type: "track",
          entity_id: track.id,
          time_range: timeRange,
          rank: index + 1,
        })),
        {
          onConflict: "user_id,entity_type,time_range,entity_id,captured_on",
          ignoreDuplicates: true,
        },
      );
      if (error) throw new Error(`upsert top tracks : ${error.message}`);
      total += topTracks.items.length;
    }

    // --- Artistes -----------------------------------------------------------
    const topArtists = await spotifyFetch<{ items: SpotifyArtist[] }>(
      userId,
      `/me/top/artists?time_range=${timeRange}&limit=50`,
    );

    if (topArtists?.items?.length) {
      const { error: artistError } = await admin.from("artists").upsert(
        topArtists.items.map((artist) => ({
          id: artist.id,
          name: artist.name,
          // `genres` est marqué déprécié côté Spotify : on l'enregistre tant
          // qu'il existe, mais le moteur s'appuie sur les tags Last.fm.
          spotify_genres: artist.genres ?? [],
        })),
        { onConflict: "id" },
      );
      if (artistError) throw new Error(`upsert artists : ${artistError.message}`);

      const { error } = await admin.from("top_items").upsert(
        topArtists.items.map((artist, index) => ({
          user_id: userId,
          entity_type: "artist",
          entity_id: artist.id,
          time_range: timeRange,
          rank: index + 1,
        })),
        {
          onConflict: "user_id,entity_type,time_range,entity_id,captured_on",
          ignoreDuplicates: true,
        },
      );
      if (error) throw new Error(`upsert top artists : ${error.message}`);
      total += topArtists.items.length;
    }
  }

  return total;
}
