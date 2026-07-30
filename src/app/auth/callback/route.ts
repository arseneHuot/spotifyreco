import { NextResponse, type NextRequest } from "next/server";

import { storeTokensFromCallback } from "@/lib/spotify/auth";
import { SPOTIFY_SCOPES } from "@/lib/spotify/scopes";
import type { SpotifyUserProfile } from "@/lib/spotify/types";
import { publicOrigin } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";

/**
 * Retour du flux OAuth Spotify.
 *
 * **C'est l'unique occasion de récupérer les tokens Spotify.** Supabase Auth
 * expose `provider_token` et `provider_refresh_token` sur la session issue de
 * `exchangeCodeForSession`, ne les stocke pas, ne les rafraîchit pas, et ne les
 * renverra jamais lors d'un rafraîchissement de session. Les manquer ici oblige
 * l'utilisateur à refaire une connexion Spotify complète.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicOrigin(request.nextUrl.origin);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/app";

  const oauthError = searchParams.get("error");
  if (oauthError) {
    return NextResponse.redirect(
      `${origin}/?error=${encodeURIComponent(oauthError)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return NextResponse.redirect(
      `${origin}/?error=${encodeURIComponent(error?.message ?? "session_failed")}`,
    );
  }

  const { session } = data;
  const providerToken = session.provider_token;
  const providerRefreshToken = session.provider_refresh_token;

  if (!providerToken || !providerRefreshToken) {
    // Arrive quand la session est reprise sans nouveau consentement. Il faut
    // repasser par l'écran d'autorisation Spotify pour réobtenir les tokens.
    return NextResponse.redirect(`${origin}/?error=no_tokens`);
  }

  // Récupère le profil pour connaître `product` : sans Premium, le Web Playback
  // SDK ne fonctionnera pas et l'interface doit le dire clairement.
  let profile: SpotifyUserProfile | null = null;
  try {
    const response = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${providerToken}` },
      cache: "no-store",
    });

    if (response.status === 403) {
      // OAuth réussi mais compte absent de l'allowlist : symptôme du plafond de
      // 5 utilisateurs du mode développement.
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/?error=not_allowlisted`);
    }

    if (response.ok) profile = (await response.json()) as SpotifyUserProfile;
  } catch {
    // Le profil est un confort, pas une condition : on garde les tokens.
  }

  if (!profile) {
    return NextResponse.redirect(`${origin}/?error=profile_unavailable`);
  }

  await storeTokensFromCallback({
    userId: session.user.id,
    accessToken: providerToken,
    refreshToken: providerRefreshToken,
    // Supabase n'expose pas la durée de validité du token fournisseur.
    // Spotify délivre systématiquement des access tokens d'une heure.
    expiresIn: 3600,
    profile,
    scopes: [...SPOTIFY_SCOPES],
  });

  return NextResponse.redirect(`${origin}${next}`);
}
