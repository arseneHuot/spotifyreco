"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { refillIfNeeded } from "@/lib/reco/generate";
import { createClient } from "@/lib/supabase/server";

const ratingSchema = z.object({
  trackId: z.string().min(1),
  rating: z.number().int().min(0).max(5),
  msAtRating: z.number().int().min(0).nullable().optional(),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Enregistre la note d'un morceau.
 *
 * Passe par le client utilisateur, pas par `service_role` : la policy RLS
 * vérifie elle-même que `user_id` correspond à la session, ce qui rend
 * impossible de noter pour le compte de quelqu'un d'autre même en cas de bug.
 */
export async function rateTrack(input: {
  trackId: string;
  rating: number;
  msAtRating?: number | null;
}): Promise<ActionResult> {
  const parsed = ratingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Note invalide" };
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) return { ok: false, error: "Session expired" };

  const { error } = await supabase.from("ratings").upsert(
    {
      user_id: user.id,
      track_id: parsed.data.trackId,
      rating: parsed.data.rating,
      ms_at_rating: parsed.data.msAtRating ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,track_id" },
  );

  if (error) return { ok: false, error: error.message };

  // Marque la recommandation correspondante comme notée, pour qu'elle sorte de
  // la file et alimente la mesure du taux de réussite de l'exploration.
  await supabase
    .from("recommendations")
    .update({ status: "rated" })
    .eq("user_id", user.id)
    .eq("track_id", parsed.data.trackId)
    .in("status", ["pending", "served"]);

  // Noter vide la file : c'est le moment naturel pour la reconstituer. La
  // génération est lente (le moteur IA raisonne pendant plus d'une minute), on
  // ne la fait donc pas attendre à l'utilisateur — l'échec éventuel est sans
  // conséquence, le prochain passage réessaiera.
  void refillIfNeeded(user.id).catch((cause) => {
    console.warn("[reco] réassort impossible :", cause);
  });

  revalidatePath("/app");
  return { ok: true };
}

/** Écarte une recommandation sans la noter. */
export async function dismissRecommendation(
  trackId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) return { ok: false, error: "Session expired" };

  const { error } = await supabase
    .from("recommendations")
    .update({ status: "dismissed" })
    .eq("user_id", user.id)
    .eq("track_id", trackId)
    .in("status", ["pending", "served"]);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/app");
  return { ok: true };
}
