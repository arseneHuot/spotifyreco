import { NextResponse } from "next/server";

import { runEnrichment } from "@/lib/enrich/pipeline";
import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Enrichit le catalogue et élargit le vivier de candidats.
 *
 * Volontairement séparé de la génération de recommandations : l'enrichissement
 * est lent (MusicBrainz plafonne à une requête par seconde) et incrémental,
 * alors que la génération doit rester quasi instantanée. Les mêler rendrait
 * chaque génération interminable.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const report = await runEnrichment(user.id);
    return NextResponse.json(report);
  } catch (cause) {
    if (cause instanceof SpotifyReauthRequiredError) {
      return NextResponse.json(
        { error: "You need to reconnect to Spotify" },
        { status: 401 },
      );
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
