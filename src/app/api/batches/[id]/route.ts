import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Supprime un groupe de recommandations.
 *
 * Les recommandations qu'il contient partent avec lui : `recommendations.batch_id`
 * porte un `on delete cascade`. En revanche les **notes** survivent — elles
 * appartiennent à l'utilisateur, pas au groupe qui a proposé le morceau, et le
 * profil de goût continue de s'en nourrir.
 *
 * Passe par le client utilisateur : la policy RLS vérifie elle-même la
 * propriété, ce qui rend impossible de supprimer le groupe d'autrui même en cas
 * d'erreur applicative.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { error } = await supabase
    .from("reco_batches")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
