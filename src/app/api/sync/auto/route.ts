import { NextResponse } from "next/server";

import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import { ingestNowPlaying, ingestRecentlyPlayed } from "@/lib/spotify/listens";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Intervalle en dessous duquel une synchronisation est inutile.
 *
 * Aligné sur la cadence du scheduler : entre deux passages du cron, il n'y a
 * rien de neuf à récupérer, et `/me/player/recently-played` renverrait les
 * mêmes cinquante entrées.
 */
const MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Synchronisation déclenchée par l'ouverture de l'application.
 *
 * Le scheduler passe déjà toutes les dix minutes ; ce point d'entrée sert
 * uniquement à l'immédiateté — voir ses écoutes de la dernière heure en
 * arrivant, sans attendre le prochain passage.
 *
 * L'anti-rebond est **côté serveur** : le client peut appeler à chaque montage
 * de page sans risque, c'est le serveur qui décide s'il y a lieu d'agir. Le
 * poser côté client le rendrait contournable par un simple rechargement.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: state } = await admin
    .from("sync_state")
    .select("last_success_at")
    .eq("user_id", user.id)
    .eq("job", "recently_played")
    .maybeSingle();

  const last = state?.last_success_at
    ? new Date(state.last_success_at).getTime()
    : 0;

  if (Date.now() - last < MIN_INTERVAL_MS) {
    return NextResponse.json({ skipped: true, reason: "too recent" });
  }

  try {
    const nowPlaying = await ingestNowPlaying(user.id);
    const recent = await ingestRecentlyPlayed(user.id);

    return NextResponse.json({
      skipped: false,
      listens: recent.inserted + nowPlaying.inserted,
      updated: recent.updated + nowPlaying.updated,
    });
  } catch (cause) {
    // Une synchronisation d'arrière-plan ne doit jamais interrompre la
    // navigation : on renvoie 200 avec le motif, à charge pour l'interface de
    // n'afficher que ce qui mérite l'attention de l'utilisateur.
    const reason =
      cause instanceof SpotifyReauthRequiredError
        ? "reauth"
        : cause instanceof SpotifyNotAllowlistedError
          ? "not_allowlisted"
          : cause instanceof SpotifyRateLimitError
            ? "rate_limited"
            : "error";

    return NextResponse.json({ skipped: true, reason });
  }
}
