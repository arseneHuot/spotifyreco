import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import {
  InvalidTrackIdError,
  NoActiveDeviceError,
  PremiumRequiredError,
  TrackUnavailableError,
  playTracks,
} from "@/lib/spotify/playback";
import { createClient } from "@/lib/supabase/server";

/**
 * Généreux au regard du travail réel (quatre appels au plus), mais
 * `spotifyFetch` peut dormir jusqu'à 60 s par tentative sur un 429 : le pire
 * cas se compte en minutes, pas en secondes.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Plafond d'un lot : c'est aussi la limite de `PUT /me/player/play`. */
const MAX_TRACKS = 100;

const bodySchema = z
  .object({
    trackId: z.string().optional(),
    trackIds: z.array(z.string()).min(1).max(MAX_TRACKS).optional(),
    // Fourni par l'événement `ready` du Web Playback SDK. Facultatif : à défaut,
    // la couche lecture retrouve seule l'appareil « NextTrack ».
    //
    // `null` est accepté explicitement : c'est ce que le client envoie tant que
    // le lecteur n'a pas émis `ready` (et après `not_ready`). Le refuser ferait
    // répondre « indiquez trackId ou trackIds » à une requête qui les contient,
    // c'est-à-dire un message faux.
    deviceId: z.string().min(1).max(256).nullish(),
  })
  .refine((body) => Boolean(body.trackId) || Boolean(body.trackIds?.length), {
    message: "Indiquez trackId ou trackIds",
  });

/** Lance un morceau — ou une file — sur l'appareil Spotify de l'utilisateur. */
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
      {
        error:
          `Invalid request: provide “trackId” or “trackIds” ` +
          `(${MAX_TRACKS} tracks at most).`,
      },
      { status: 400 },
    );
  }

  const { trackId, trackIds, deviceId } = parsed.data;
  const ids = trackIds ?? (trackId ? [trackId] : []);

  try {
    await playTracks(user.id, ids, deviceId ?? undefined);
    return NextResponse.json({ ok: true, tracks: ids.length });
  } catch (cause) {
    if (cause instanceof InvalidTrackIdError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    if (cause instanceof SpotifyReauthRequiredError) {
      return NextResponse.json(
        { error: "You need to reconnect to Spotify" },
        { status: 401 },
      );
    }
    if (cause instanceof PremiumRequiredError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof TrackUnavailableError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    if (cause instanceof SpotifyNotAllowlistedError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    // 404 côté client : rien à réessayer tant que le lecteur n'est pas ouvert.
    if (cause instanceof NoActiveDeviceError) {
      return NextResponse.json({ error: cause.message }, { status: 404 });
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
