import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import {
  exportRecommendations,
  listWritablePlaylists,
  PlaylistForbiddenError,
  PlaylistNotFoundError,
} from "@/lib/spotify/playlists";
import { getAccountSummary } from "@/lib/spotify/auth";
import { DISPLAY_TIME_ZONE } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Identifiant Spotify : 22 caractères en base62. Le vérifier n'est pas
 * cosmétique — ces valeurs sont interpolées dans un chemin d'API et dans des
 * URI `spotify:track:…`.
 */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

const bodySchema = z.object({
  trackIds: z
    .array(z.string().regex(SPOTIFY_ID, "Invalid track ID"))
    .min(1, "Select at least one track")
    // Le plafond correspond à ce que Spotify accepte par requête d'ajout : au
    // delà, l'export se ferait en plusieurs appels sur un quota partagé.
    .max(100, "100 tracks maximum per export"),
  name: z
    .string()
    .trim()
    .min(1, "The playlist name can't be empty")
    .max(100, "The name is limited to 100 characters")
    .optional(),
  playlistId: z
    .string()
    .regex(SPOTIFY_ID, "Invalid playlist ID")
    .optional(),
});

/**
 * Nom par défaut, du type « Rotation — 28 July 2026 ».
 *
 * Le fuseau est fixé à Paris : les fonctions Vercel tournent en UTC, et un
 * export passé 1 h du matin serait daté de la veille.
 */
function defaultPlaylistName(): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: DISPLAY_TIME_ZONE,
  }).format(new Date());

  return `Rotation — ${date}`;
}

/** Exporte une sélection de recommandations vers une playlist Spotify. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const result = await exportRecommendations(user.id, {
      trackIds: parsed.data.trackIds,
      name: parsed.data.name ?? defaultPlaylistName(),
      playlistId: parsed.data.playlistId,
    });

    return NextResponse.json(result);
  } catch (cause) {
    if (cause instanceof PlaylistNotFoundError) {
      return NextResponse.json({ error: cause.message }, { status: 404 });
    }
    if (cause instanceof SpotifyReauthRequiredError) {
      return NextResponse.json(
        { error: "You need to reconnect to Spotify" },
        { status: 401 },
      );
    }
    // Avant `SpotifyNotAllowlistedError` : c'est le même 403 côté Spotify, mais
    // requalifié par une sonde `/me`. Le compte n'est pas en cause.
    if (cause instanceof PlaylistForbiddenError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof SpotifyNotAllowlistedError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof SpotifyRateLimitError) {
      return NextResponse.json(
        { error: "Spotify rate limit reached, try again later" },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "Erreur inconnue" },
      { status: 500 },
    );
  }
}

/**
 * Liste les playlists dans lesquelles la sélection peut être versée.
 *
 * L'appel à Spotify est nécessaire : la table locale ne connaît que les
 * playlists créées depuis Rotation, alors qu'on veut aussi pouvoir alimenter
 * celles qui existaient avant. Le repli sur la table locale garde le panneau
 * utilisable si Spotify est indisponible ou le quota épuisé.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const account = await getAccountSummary(user.id);

  if (account?.spotifyUserId) {
    try {
      const playlists = await listWritablePlaylists(
        user.id,
        account.spotifyUserId,
      );
      return NextResponse.json({ playlists, source: "spotify" });
    } catch (cause) {
      // Pas une erreur fatale : on retombe sur ce qu'on sait localement plutôt
      // que de rendre l'export impossible.
      console.warn(
        "[playlists] liste Spotify indisponible :",
        cause instanceof Error ? cause.message : cause,
      );
    }
  }

  // La RLS filtre déjà sur le propriétaire ; le `eq` explicite emprunte l'index
  // (user_id, updated_at desc) et documente l'intention.
  const { data, error } = await supabase
    .from("playlists")
    .select("id, spotify_playlist_id, name, track_count, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: "Couldn't load playlists" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    playlists: (data ?? []).map((row) => ({
      playlistId: row.spotify_playlist_id,
      name: row.name,
      trackCount: row.track_count,
      fromRotation: true,
    })),
    source: "local",
  });
}
