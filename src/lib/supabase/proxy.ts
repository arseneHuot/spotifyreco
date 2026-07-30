import "server-only";

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/** Routes accessibles sans session. Tout le reste redirige vers l'accueil. */
const PUBLIC_PATHS = ["/", "/auth", "/legal", "/api/cron"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Rafraîchit la session Supabase et écrit les cookies mis à jour sur la
 * réponse. Doit tourner sur chaque requête : les Server Components ne peuvent
 * pas écrire de cookies, donc sans ce passage les tokens rafraîchis seraient
 * perdus et l'utilisateur serait déconnecté aléatoirement.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } =
    env();

  const supabase = createServerClient<Database>(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          // @supabase/ssr fournit ici les en-têtes anti-cache. Sans eux, un CDN
          // ou un proxy peut mettre en cache une réponse porteuse d'un
          // Set-Cookie de session et servir le token d'un utilisateur à un
          // autre.
          if (headers) {
            for (const [k, v] of Object.entries(headers)) {
              response.headers.set(k, v);
            }
          }
        },
      },
    },
  );

  // `getClaims()` valide la signature du JWT localement (via la JWKS du projet)
  // au lieu d'appeler l'API Auth à chaque requête. Cet appel doit rester ici :
  // il déclenche le refresh, et donc `setAll`, avant que la réponse ne parte.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims ?? null;

  const { pathname } = request.nextUrl;

  if (!claims && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("redirectedFrom", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}
