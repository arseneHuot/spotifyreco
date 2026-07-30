import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Client Supabase pour Server Components, Server Actions et Route Handlers.
 *
 * Il agit avec les droits de l'utilisateur connecté : toutes les policies RLS
 * s'appliquent. À recréer à chaque requête — jamais de singleton au niveau du
 * module, car sur Vercel Fluid Compute plusieurs requêtes partagent la même
 * instance de fonction et se retrouveraient à partager une session.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } =
    env();

  return createServerClient<Database>(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Un Server Component ne peut pas écrire de cookies. C'est sans
            // conséquence tant que le proxy rafraîchit la session : il l'a déjà
            // fait pour cette requête. Voir src/proxy.ts.
          }
        },
      },
    },
  );
}
