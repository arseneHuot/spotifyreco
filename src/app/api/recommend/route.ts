import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createJob, latestJob, runJob } from "@/lib/reco/jobs";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  engine: z.enum(["algo", "ai", "both"]).default("both"),
  // Nom du groupe. Laissé libre : s'il est absent, le générateur retombe sur un
  // nom daté.
  name: z.string().trim().min(1).max(80).optional(),
});

/**
 * Ouvre une génération et rend la main aussitôt.
 *
 * La génération ne tient pas dans une requête : deux à trois minutes pour le
 * moteur IA, contre cinq avant que la fonction ne soit coupée sans préavis.
 * L'utilisateur restait devant un écran figé, perdait tout en rechargeant, et
 * une coupure ne laissait aucune trace de ce qui s'était passé.
 *
 * Le travail se poursuit donc après la réponse, via `after`, et publie son
 * avancement dans `generation_jobs`. L'interface suit la tâche au lieu
 * d'attendre la réponse — et la retrouve au rechargement.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown engine" }, { status: 400 });
  }

  const { engine, name } = parsed.data;

  // Une seule génération à la fois : deux lancements simultanés se
  // disputeraient le quota Spotify, et le suivi n'en montrerait qu'un.
  const current = await latestJob(user.id);
  if (current?.status === "running") {
    return NextResponse.json(
      { error: "A selection is already being generated.", job: current },
      { status: 409 },
    );
  }

  const jobId = await createJob(user.id, engine, name);

  after(async () => {
    await runJob(jobId, user.id, { engine, kind: "manual", name });
  });

  return NextResponse.json({ jobId }, { status: 202 });
}
