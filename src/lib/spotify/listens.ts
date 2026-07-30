import "server-only";

import { upsertTracks } from "@/lib/spotify/catalog";
import { spotifyFetch } from "@/lib/spotify/client";
import type {
  SpotifyCurrentlyPlaying,
  SpotifyPlayHistoryItem,
} from "@/lib/spotify/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Collecte des écoutes.
 *
 * L'API Spotify ne renvoie **jamais** la durée réellement écoutée : la seule
 * source complète est l'export RGPD, qui demande plusieurs semaines. On la
 * reconstruit donc à partir de deux flux complémentaires :
 *
 *  - `/me/player/recently-played` donne l'horodatage exact des lectures passées,
 *    mais rien sur la durée, et plafonne à 50 éléments sans historique profond ;
 *  - `/me/player` expose `progress_ms` du morceau en cours. En l'observant à
 *    chaque passage du scheduler, on mesure la progression réelle — c'est ce qui
 *    permet de distinguer un morceau écouté en entier d'un morceau zappé au bout
 *    de dix secondes.
 *
 * Les deux flux décrivent parfois la même écoute : la réconciliation est faite
 * par `findNearbyListen`.
 */

/** Tolérance de rapprochement entre deux observations d'une même écoute. */
const RECONCILE_WINDOW_MS = 3 * 60 * 1000;

export type IngestResult = {
  inserted: number;
  updated: number;
  cursor: string | null;
};

/**
 * Récupère les lectures récentes depuis le dernier curseur.
 *
 * Spotify renvoie au plus 50 éléments et ne permet pas de remonter plus loin :
 * un utilisateur qui écoute plus de 50 morceaux entre deux passages perd la
 * différence. C'est la raison d'être d'un scheduler fréquent.
 */
export async function ingestRecentlyPlayed(
  userId: string,
): Promise<IngestResult> {
  const admin = createAdminClient();

  const { data: state } = await admin
    .from("sync_state")
    .select("cursor")
    .eq("user_id", userId)
    .eq("job", "recently_played")
    .maybeSingle();

  const after = state?.cursor;
  const path = after
    ? `/me/player/recently-played?limit=50&after=${after}`
    : "/me/player/recently-played?limit=50";

  const page = await spotifyFetch<{
    items: SpotifyPlayHistoryItem[];
    cursors?: { after?: string; before?: string } | null;
  }>(userId, path);

  const items = page?.items ?? [];
  if (items.length === 0) {
    await recordSync(userId, "recently_played", after ?? null, null);
    return { inserted: 0, updated: 0, cursor: after ?? null };
  }

  await upsertTracks(items.map((item) => item.track));

  let inserted = 0;
  let updated = 0;

  for (const item of items) {
    const playedAt = new Date(item.played_at);

    // Le morceau a peut-être déjà été vu « en cours de lecture » par le poller ;
    // dans ce cas on conserve la ligne existante, qui porte la durée écoutée.
    const existing = await findNearbyListen(
      userId,
      item.track.id,
      playedAt,
      item.track.duration_ms,
    );

    if (existing) {
      await admin
        .from("listens")
        .update({ context_uri: item.context?.uri ?? null })
        .eq("id", existing.id);
      updated++;
      continue;
    }

    const { error } = await admin.from("listens").insert({
      user_id: userId,
      track_id: item.track.id,
      played_at: playedAt.toISOString(),
      ms_played: null, // inconnu par construction sur ce flux
      source: "recently_played",
      context_uri: item.context?.uri ?? null,
    });

    // 23505 = doublon sur (user_id, track_id, played_at) : la même écoute a déjà
    // été ingérée lors d'un passage précédent. Sans gravité.
    if (error && error.code !== "23505") {
      throw new Error(`insert listen : ${error.message}`);
    }
    if (!error) inserted++;
  }

  // Le curseur `after` de Spotify est un timestamp en millisecondes.
  const newestPlayedAt = Math.max(
    ...items.map((item) => new Date(item.played_at).getTime()),
  );
  const cursor = String(newestPlayedAt);

  await recordSync(userId, "recently_played", cursor, null);
  return { inserted, updated, cursor };
}

/**
 * Observe la lecture en cours pour mesurer la durée réellement écoutée.
 *
 * Appelée à chaque passage du scheduler : chaque observation rapproche
 * `ms_played` de la valeur réelle. Deux passages sur le même morceau mettent à
 * jour la même ligne plutôt que d'en créer une seconde.
 */
export async function ingestNowPlaying(userId: string): Promise<IngestResult> {
  const admin = createAdminClient();

  const playing = await spotifyFetch<SpotifyCurrentlyPlaying>(
    userId,
    "/me/player",
  );

  // 204 (rien en cours), publicité, podcast : rien à enregistrer.
  if (!playing?.item?.id || playing.currently_playing_type !== "track") {
    return { inserted: 0, updated: 0, cursor: null };
  }

  const track = playing.item;
  const progressMs = playing.progress_ms ?? 0;

  // En dessous de 30 secondes, Spotify ne comptabilise pas l'écoute et le
  // morceau peut encore être abandonné : on attend le passage suivant.
  if (progressMs < 30_000) {
    return { inserted: 0, updated: 0, cursor: null };
  }

  await upsertTracks([track]);

  // Début de lecture estimé. Stable tant que la lecture est continue ; une pause
  // le fait dériver, d'où la fenêtre de tolérance au rapprochement.
  const startedAt = new Date(Date.now() - progressMs);
  const completion = track.duration_ms
    ? Math.min(1, progressMs / track.duration_ms)
    : null;

  const existing = await findNearbyListen(
    userId,
    track.id,
    startedAt,
    track.duration_ms,
  );

  if (existing) {
    // La progression ne peut que croître : si l'utilisateur a rembobiné, on
    // conserve le maximum observé plutôt que de perdre le temps déjà mesuré.
    const bestMs = Math.max(existing.ms_played ?? 0, progressMs);
    await admin
      .from("listens")
      .update({
        ms_played: bestMs,
        completion: track.duration_ms
          ? Math.min(1, bestMs / track.duration_ms)
          : null,
        source: "now_playing",
      })
      .eq("id", existing.id);

    return { inserted: 0, updated: 1, cursor: null };
  }

  const { error } = await admin.from("listens").insert({
    user_id: userId,
    track_id: track.id,
    played_at: startedAt.toISOString(),
    ms_played: progressMs,
    completion,
    source: "now_playing",
    context_uri: playing.context?.uri ?? null,
  });

  if (error && error.code !== "23505") {
    throw new Error(`insert now-playing : ${error.message}`);
  }

  return { inserted: error ? 0 : 1, updated: 0, cursor: null };
}

/**
 * Cherche une écoute du même morceau assez proche dans le temps pour être la
 * même lecture vue sous un autre angle.
 *
 * La fenêtre couvre la durée du morceau plus une marge : `recently-played`
 * horodate la lecture d'une manière qui ne coïncide pas exactement avec le
 * début observé via `progress_ms`.
 */
async function findNearbyListen(
  userId: string,
  trackId: string,
  playedAt: Date,
  durationMs?: number | null,
): Promise<{ id: number; ms_played: number | null } | null> {
  const admin = createAdminClient();

  const windowMs = (durationMs ?? 0) + RECONCILE_WINDOW_MS;
  const from = new Date(playedAt.getTime() - windowMs).toISOString();
  const to = new Date(playedAt.getTime() + windowMs).toISOString();

  const { data } = await admin
    .from("listens")
    .select("id, ms_played")
    .eq("user_id", userId)
    .eq("track_id", trackId)
    .gte("played_at", from)
    .lte("played_at", to)
    .order("played_at", { ascending: false })
    .limit(1);

  return data?.[0] ?? null;
}

async function recordSync(
  userId: string,
  job: string,
  cursor: string | null,
  error: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  await admin.from("sync_state").upsert(
    {
      user_id: userId,
      job,
      cursor,
      last_run_at: now,
      last_success_at: error ? undefined : now,
      last_error: error,
      consecutive_failures: error ? 1 : 0,
    },
    { onConflict: "user_id,job" },
  );
}
