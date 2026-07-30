import "server-only";

import {
  generateRecommendations,
  type BatchKind,
  type RecoEngine,
} from "@/lib/reco/generate";
import type { ProgressEvent } from "@/lib/reco/progress";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Génération suivie, hors de la requête HTTP.
 *
 * Le travail dure deux à trois minutes : le laisser dans la requête obligeait
 * l'utilisateur à garder son onglet ouvert sans rien pouvoir faire, et un
 * rechargement perdait tout. Ici, la requête crée la tâche et rend la main ;
 * la génération continue et publie son avancement en base, que l'interface
 * relit à son rythme.
 */

/** En dessous, une tâche « running » est considérée comme abandonnée. */
const STALE_AFTER_MS = 6 * 60_000;

export type JobView = {
  id: string;
  status: "running" | "done" | "failed";
  engine: string;
  name: string | null;
  progress: number;
  step: string | null;
  batchId: string | null;
  error: string | null;
  startedAt: string;
};

export async function createJob(
  userId: string,
  engine: RecoEngine,
  name?: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("generation_jobs")
    .insert({
      user_id: userId,
      engine,
      name: name ?? null,
      status: "running",
      step: "Starting up",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Impossible d'ouvrir la génération : ${error?.message}`);
  }

  return data.id;
}

/**
 * Exécute la génération et tient la tâche à jour.
 *
 * Ne lève jamais : l'appelant l'a détachée de la réponse, une exception ici
 * n'aurait personne pour l'attraper. Tout échec est consigné dans la tâche,
 * qui est le seul canal restant vers l'utilisateur.
 */
export async function runJob(
  jobId: string,
  userId: string,
  options: { engine: RecoEngine; kind: BatchKind; name?: string },
): Promise<void> {
  const admin = createAdminClient();

  // L'avancement est écrit au fil de l'eau, mais pas à chaque événement : le
  // moteur en émet un par seconde, et chacun coûterait un aller-retour à la
  // base pour un pixel de barre. Un événement arrivé pendant la fenêtre n'est
  // pas jeté pour autant : il part en écriture différée. Sans cela, l'état
  // affiché restait figé sur l'avant-dernière étape — la dernière, émise juste
  // après la précédente, tombait dans la fenêtre et disparaissait.
  let lastWrite = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const write = (event: Extract<ProgressEvent, { type: "step" }>) => {
    lastWrite = Date.now();
    void admin
      .from("generation_jobs")
      .update({
        progress: event.at,
        step: event.total
          ? `${event.label} (${event.done}/${event.total})`
          : event.label,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .then(undefined, () => {
        // Une écriture de progression perdue n'invalide pas la génération.
      });
  };

  const onProgress = (event: ProgressEvent) => {
    if (event.type !== "step") return;

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }

    const elapsed = Date.now() - lastWrite;
    if (elapsed >= 1500) {
      write(event);
    } else {
      flushTimer = setTimeout(() => write(event), 1500 - elapsed);
    }
  };

  const stopFlushing = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  try {
    const result = await generateRecommendations(userId, {
      engine: options.engine,
      kind: options.kind,
      name: options.name,
      onProgress,
    });

    // Sans cela, une écriture différée partie juste avant la fin pouvait
    // écraser l'état final avec une étape intermédiaire.
    stopFlushing();

    await admin
      .from("generation_jobs")
      .update({
        status: "done",
        progress: 1,
        step: null,
        batch_id: result.batchId,
        result: JSON.parse(JSON.stringify(result)),
        // `reason` est conservé même quand le lot n'est pas vide : en mode
        // « Both », le moteur maison peut le remplir seul et masquer ainsi le
        // fait que l'IA n'a rien donné. L'utilisateur croirait ses deux
        // moteurs en état de marche.
        error: result.reason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } catch (cause) {
    stopFlushing();
    console.error("[jobs] génération échouée :", { jobId }, cause);

    await admin
      .from("generation_jobs")
      .update({
        status: "failed",
        step: null,
        error: cause instanceof Error ? cause.message : "Unknown error",
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  }
}

/**
 * Dernière génération de l'utilisateur.
 *
 * Une tâche encore « running » alors que la fonction qui la portait a été
 * coupée depuis longtemps est rapportée comme échouée : sans cela, l'interface
 * afficherait une barre qui ne bougerait plus jamais.
 */
export async function latestJob(userId: string): Promise<JobView | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("generation_jobs")
    .select("id, status, engine, name, progress, step, batch_id, error, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;

  const stale =
    data.status === "running" &&
    Date.now() - new Date(data.updated_at).getTime() > STALE_AFTER_MS;

  return {
    id: data.id,
    status: stale ? "failed" : data.status,
    engine: data.engine,
    name: data.name,
    progress: data.progress,
    step: data.step,
    batchId: data.batch_id,
    error: stale
      ? "The server stopped before the selection was finished."
      : data.error,
    startedAt: data.created_at,
  };
}
