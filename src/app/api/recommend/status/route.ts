import { NextResponse } from "next/server";

import { latestJob } from "@/lib/reco/jobs";
import { createClient } from "@/lib/supabase/server";

// Route délibérément courte, et séparée de celle qui lance la génération.
//
// `POST /api/recommend` garde son instance occupée plusieurs minutes par le
// travail détaché : interroger l'avancement sur la même route revenait à
// demander à une fonction saturée de répondre, et Vercel refusait les
// sondages en 503 — sans même les journaliser. Le suivi doit vivre ailleurs.
export const maxDuration = 10;
export const dynamic = "force-dynamic";

/** État de la dernière génération, pour le suivi et la reprise au chargement. */
export async function GET() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  return NextResponse.json({ job: await latestJob(user.id) });
}
