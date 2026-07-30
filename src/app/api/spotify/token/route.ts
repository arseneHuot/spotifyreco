import { NextResponse } from "next/server";

import { SpotifyReauthRequiredError } from "@/lib/spotify/errors";
import { getValidAccessToken } from "@/lib/spotify/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Fournit un access token au Web Playback SDK.
 *
 * Le SDK s'exécute dans le navigateur et réclame un token via son rappel
 * `getOAuthToken` : l'exposer est inhérent à son fonctionnement. On ne transmet
 * que l'access token, valable une heure — le refresh token, lui, ne quitte
 * jamais le serveur et reste chiffré en base.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  try {
    const accessToken = await getValidAccessToken(user.id);
    return NextResponse.json(
      { accessToken },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    if (cause instanceof SpotifyReauthRequiredError) {
      return NextResponse.json(
        { error: "reauth_required" },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return NextResponse.json({ error: "Erreur interne" }, { status: 500 });
  }
}
