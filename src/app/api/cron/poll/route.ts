import { NextResponse, type NextRequest } from "next/server";

import { safeCompare } from "@/lib/crypto";
import { env } from "@/lib/env";
import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
} from "@/lib/spotify/errors";
import { SpotifyReauthRequiredError } from "@/lib/spotify/errors";
import { ingestNowPlaying, ingestRecentlyPlayed } from "@/lib/spotify/listens";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Collecte périodique des écoutes, pour tous les comptes actifs.
 *
 * Déclenchée par un scheduler externe, et non par Vercel Cron : le plan Hobby
 * plafonne à une exécution par jour, avec une précision de ±59 minutes, alors
 * qu'il faut passer toutes les 5 à 15 minutes — `/me/player/recently-played`
 * ne retient que 50 éléments, et `progress_ms` doit être échantillonné pendant
 * la lecture pour mesurer la durée réellement écoutée.
 *
 * Voir docs/scheduler.md pour la mise en place.
 */

// Le quota Spotify est partagé par tous les utilisateurs : on traite les comptes
// en série, jamais en parallèle.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.replace(/^Bearer\s+/i, "");

  if (!provided || !safeCompare(provided, env().CRON_SECRET)) {
    // 404 plutôt que 401 : inutile de signaler l'existence de l'endpoint.
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();

  const { data: accounts, error } = await admin
    .from("spotify_accounts")
    .select("user_id")
    .eq("status", "active");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const account of accounts ?? []) {
    const userId = account.user_id;

    try {
      // L'ordre compte : on observe d'abord la lecture en cours, pour ne pas
      // rater la fenêtre pendant laquelle le morceau est encore actif.
      const nowPlaying = await ingestNowPlaying(userId);
      const recent = await ingestRecentlyPlayed(userId);

      results.push({
        userId,
        ok: true,
        nowPlaying: nowPlaying.inserted + nowPlaying.updated,
        recentInserted: recent.inserted,
        recentUpdated: recent.updated,
      });
    } catch (cause) {
      // Une erreur sur un compte ne doit pas interrompre les autres.
      if (cause instanceof SpotifyRateLimitError) {
        // Quota épuisé : il l'est pour tout le monde, inutile de continuer.
        results.push({ userId, ok: false, reason: "rate_limited" });
        break;
      }

      const reason =
        cause instanceof SpotifyReauthRequiredError
          ? "needs_reauth"
          : cause instanceof SpotifyNotAllowlistedError
            ? "not_allowlisted"
            : "error";

      results.push({
        userId,
        ok: false,
        reason,
        message: cause instanceof Error ? cause.message : String(cause),
      });

      await admin
        .from("sync_state")
        .upsert(
          {
            user_id: userId,
            job: "poll",
            last_run_at: new Date().toISOString(),
            last_error: cause instanceof Error ? cause.message : String(cause),
          },
          { onConflict: "user_id,job" },
        );
    }
  }

  return NextResponse.json({ polledAt: new Date().toISOString(), results });
}
