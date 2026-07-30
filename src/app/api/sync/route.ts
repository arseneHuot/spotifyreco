import { NextResponse } from "next/server";

import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import { syncSavedTracks, syncTopItems } from "@/lib/spotify/library";
import { ingestNowPlaying, ingestRecentlyPlayed } from "@/lib/spotify/listens";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Synchronisation déclenchée par l'utilisateur depuis l'interface.
 *
 * Contrairement au job du scheduler, on ne traite que le compte de l'appelant.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const nowPlaying = await ingestNowPlaying(user.id);
    const recent = await ingestRecentlyPlayed(user.id);
    const saved = await syncSavedTracks(user.id, { maxItems: 500 });
    await syncTopItems(user.id);

    return NextResponse.json({
      listens: recent.inserted + nowPlaying.inserted,
      saved,
    });
  } catch (cause) {
    if (cause instanceof SpotifyNotAllowlistedError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof SpotifyReauthRequiredError) {
      return NextResponse.json(
        { error: "You need to reconnect to Spotify" },
        { status: 401 },
      );
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
