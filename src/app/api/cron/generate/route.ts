import { NextResponse, type NextRequest } from "next/server";

import { safeCompare } from "@/lib/crypto";
import { env } from "@/lib/env";
import { generateRecommendations } from "@/lib/reco/generate";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Sélection du jour, produite sans intervention.
 *
 * Une seule par jour et par utilisateur : l'index unique
 * (utilisateur, nom, jour) de `reco_batches` le garantit en base, donc un
 * double déclenchement du scheduler ne peut pas produire deux groupes.
 */
export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.replace(/^Bearer\s+/i, "");

  if (!provided || !safeCompare(provided, env().CRON_SECRET)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const admin = createAdminClient();
  const { data: accounts } = await admin
    .from("spotify_accounts")
    .select("user_id")
    .eq("status", "active");

  const results: Array<Record<string, unknown>> = [];

  for (const account of accounts ?? []) {
    try {
      const result = await generateRecommendations(account.user_id, {
        kind: "auto_daily",
      });

      results.push({
        userId: account.user_id,
        batchName: result.batchName,
        generated: result.generated,
        byEngine: result.byEngine,
        reason: result.reason,
      });
    } catch (cause) {
      results.push({
        userId: account.user_id,
        error: cause instanceof Error ? cause.message : "erreur",
      });
    }
  }

  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}
