import { NextResponse, type NextRequest } from "next/server";

import { publicOrigin } from "@/lib/site-url";
import { SPOTIFY_SCOPE_STRING } from "@/lib/spotify/scopes";
import { createClient } from "@/lib/supabase/server";

/**
 * Démarre la connexion Spotify.
 *
 * Se connecter avec Spotify crée aussi le compte Rotation : il n'y a qu'une
 * seule identité, donc pas de compte à créer puis à relier dans un second temps.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicOrigin(request.nextUrl.origin);
  const next = searchParams.get("next") ?? "/app";

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "spotify",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      scopes: SPOTIFY_SCOPE_STRING,
      queryParams: {
        // Force l'écran de consentement. Sans cela, Spotify renvoie
        // l'utilisateur immédiatement et Supabase ne fournit pas de nouveau
        // `provider_refresh_token` — indispensable après une réautorisation.
        show_dialog: "true",
      },
    },
  });

  if (error || !data.url) {
    return NextResponse.redirect(
      `${origin}/?error=${encodeURIComponent(error?.message ?? "oauth_indisponible")}`,
    );
  }

  return NextResponse.redirect(data.url);
}
