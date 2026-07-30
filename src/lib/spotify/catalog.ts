import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  largestImage,
  releaseYear,
  type SpotifyTrack,
} from "@/lib/spotify/types";

/**
 * Enregistre les objets du catalogue (artistes, albums, morceaux) rencontrés
 * dans une réponse Spotify.
 *
 * Le catalogue est mutualisé entre tous les utilisateurs : deux personnes qui
 * écoutent le même morceau ne provoquent qu'un seul enregistrement. C'est
 * essentiel ici, puisque les endpoints de récupération par lots ont été
 * supprimés en mode développement — chaque morceau inconnu coûte désormais une
 * requête à lui seul, sur un quota partagé.
 */
export async function upsertTracks(tracks: SpotifyTrack[]): Promise<void> {
  const unique = new Map<string, SpotifyTrack>();
  for (const track of tracks) {
    if (track?.id) unique.set(track.id, track);
  }
  if (unique.size === 0) return;

  const admin = createAdminClient();
  const list = [...unique.values()];

  // --- Artistes -------------------------------------------------------------
  const artists = new Map<string, { id: string; name: string }>();
  for (const track of list) {
    for (const artist of track.artists ?? []) {
      if (artist?.id) artists.set(artist.id, { id: artist.id, name: artist.name });
    }
  }

  if (artists.size > 0) {
    const { error } = await admin
      .from("artists")
      .upsert([...artists.values()], { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`upsert artists : ${error.message}`);
  }

  // --- Albums ---------------------------------------------------------------
  const albums = new Map<string, Record<string, unknown>>();
  for (const track of list) {
    const album = track.album;
    if (album?.id && !albums.has(album.id)) {
      albums.set(album.id, {
        id: album.id,
        name: album.name,
        image_url: largestImage(album.images),
        release_date: album.release_date ?? null,
        release_year: releaseYear(album),
        total_tracks: album.total_tracks ?? null,
      });
    }
  }

  if (albums.size > 0) {
    const { error } = await admin
      .from("albums")
      // @ts-expect-error — l'inférence de type de Supabase sur les upserts en
      // lot bute sur les objets construits dynamiquement ; la forme est validée
      // par le schéma SQL.
      .upsert([...albums.values()], { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`upsert albums : ${error.message}`);
  }

  // --- Morceaux -------------------------------------------------------------
  const { error: tracksError } = await admin.from("tracks").upsert(
    list.map((track) => ({
      id: track.id,
      name: track.name,
      album_id: track.album?.id ?? null,
      duration_ms: track.duration_ms ?? null,
      isrc: track.external_ids?.isrc ?? null,
      explicit: track.explicit ?? null,
      popularity: track.popularity ?? null,
    })),
    { onConflict: "id" },
  );
  if (tracksError) throw new Error(`upsert tracks : ${tracksError.message}`);

  // --- Liens morceau ↔ artiste ---------------------------------------------
  const links = list.flatMap((track) =>
    (track.artists ?? []).map((artist, index) => ({
      track_id: track.id,
      artist_id: artist.id,
      position: index,
    })),
  );

  if (links.length > 0) {
    const { error } = await admin
      .from("track_artists")
      .upsert(links, { onConflict: "track_id,artist_id", ignoreDuplicates: true });
    if (error) throw new Error(`upsert track_artists : ${error.message}`);
  }
}
