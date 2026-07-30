import { NextResponse, type NextRequest } from "next/server";

import { safeCompare } from "@/lib/crypto";
import { runEnrichment } from "@/lib/enrich/pipeline";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Enrichissement de fond, déclenché par le scheduler.
 *
 * Le travail est intrinsèquement lent — MusicBrainz plafonne à une requête par
 * seconde et throttle en plus — donc il ne peut pas tenir dans une action
 * utilisateur. Sans ce passage régulier, il faudrait cliquer « Enrichir »
 * plusieurs dizaines de fois pour couvrir un catalogue de quelques centaines de
 * morceaux.
 *
 * Chaque exécution reprend là où la précédente s'est arrêtée : le pipeline ne
 * traite que ce qui n'est pas encore décrit.
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
  // Budget réparti entre les comptes : une exécution ne doit pas être monopolisée
  // par le premier utilisateur de la liste.
  const perUser = Math.floor(240_000 / Math.max(1, accounts?.length ?? 1));

  for (const account of accounts ?? []) {
    try {
      const report = await runEnrichment(account.user_id, {
        budgetMs: perUser,
      });
      results.push({
        userId: account.user_id,
        featuresAdded: report.featuresAdded,
        mbidsResolved: report.mbidsResolved,
        tagsAdded: report.tagsAdded,
        candidatesAdded: report.candidatesAdded,
        remaining: report.remaining,
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
