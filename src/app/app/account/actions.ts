"use server";

import { redirect } from "next/navigation";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

/**
 * Supprime définitivement le compte et toutes les données associées.
 *
 * La suppression de la ligne `auth.users` suffit : toutes les tables portant un
 * `user_id` déclarent `on delete cascade`, y compris les tokens Spotify. Le
 * catalogue partagé (artistes, morceaux, tags) survit — il ne contient aucune
 * donnée personnelle, seulement des métadonnées publiques.
 */
export async function deleteAccount(): Promise<void> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) redirect("/");

  await supabase.auth.signOut();

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    throw new Error(`Échec de la suppression du compte : ${error.message}`);
  }

  redirect("/?deleted=1");
}
