import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Client `service_role` : **contourne intégralement la RLS**.
 *
 * Réservé à trois usages, tous hors session utilisateur :
 *  - lire et écrire `spotify_accounts` (tokens chiffrés — table volontairement
 *    inaccessible au rôle `authenticated`, y compris à son propriétaire) ;
 *  - les jobs du scheduler, qui tournent sans utilisateur connecté ;
 *  - l'écriture du catalogue partagé (artists / albums / tracks / features).
 *
 * Toute requête faite avec ce client doit filtrer explicitement sur `user_id` :
 * il n'y a plus aucun garde-fou en base.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY } = env();

  return createSupabaseClient<Database>(
    NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
