import Link from "next/link";
import { redirect } from "next/navigation";

import { AutoSync } from "@/components/auto-sync";
import { GenerateButton } from "@/components/generate-button";
import {
  RecoWorkspace,
  type RecoGroup,
  type RecoItem,
} from "@/components/reco-workspace";
import { formatDate } from "@/lib/format";
import { getAccountSummary } from "@/lib/spotify/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) redirect("/");

  const account = await getAccountSummary(user.id);

  const [{ data: recommendations }, { data: ratings }, { count: listenCount }] =
    await Promise.all([
      supabase
        .from("recommendations")
        .select(
          `track_id, exploration, reasons, engine, batch_id, created_at,
           reco_batches(name, kind, created_at),
           tracks(
             name,
             albums(image_url),
             track_artists(artists(name)),
             track_tags(tags(name))
           )`,
        )
        .eq("user_id", user.id)
        .in("status", ["pending", "served", "rated"])
        .order("created_at", { ascending: false })
        .order("score", { ascending: false })
        .limit(400),
      supabase.from("ratings").select("track_id, rating").eq("user_id", user.id),
      supabase
        .from("listens")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id),
    ]);

  const ratingByTrack = new Map(
    (ratings ?? []).map((r) => [r.track_id, r.rating]),
  );

  // Les recommandations arrivent déjà triées ; construire les groupes au fil de
  // la lecture préserve cet ordre, là où un regroupement après coup le perdrait.
  const groups: RecoGroup[] = [];

  for (const reco of recommendations ?? []) {
    const batch = reco.reco_batches;
    if (!batch) continue;

    const track = reco.tracks;
    const reasons = reco.reasons as Record<string, unknown> | null;

    const item: RecoItem = {
      trackId: reco.track_id,
      name: track?.name ?? reco.track_id,
      artists:
        track?.track_artists
          ?.map((link) => link.artists?.name)
          .filter(Boolean)
          .join(", ") ?? "Unknown artist",
      cover: track?.albums?.image_url ?? null,
      engine: reco.engine,
      exploration: reco.exploration,
      explanation:
        typeof reasons?.explication === "string" ? reasons.explication : null,
      tags:
        track?.track_tags
          ?.map((link) => link.tags?.name)
          .filter((name): name is string => Boolean(name)) ?? [],
      rating: ratingByTrack.get(reco.track_id) ?? null,
      batchId: reco.batch_id,
    };

    const existing = groups.find((g) => g.id === reco.batch_id);
    if (existing) existing.items.push(item);
    else
      groups.push({
        id: reco.batch_id,
        name: batch.name,
        kind: batch.kind,
        createdAt: batch.created_at,
        items: [item],
      });
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <AutoSync />

      {/* La navigation est en haut et non en pied de page : le lecteur est fixé
          en bas de l'écran et recouvrait le pied de page, rendant ces liens
          inatteignables. */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-baseline gap-3 sm:gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
            NextTrack
          </p>
          <p className="truncate text-xs text-muted">
            {listenCount ?? 0} listens · {ratings?.length ?? 0} ratings
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 sm:gap-4">
          {/* Les marges négatives compensent le rembourrage : la cible tactile
              atteint 44 px sans que l'en-tête ne grandisse. */}
          <nav className="flex items-center gap-4 text-xs text-muted">
            <Link
              href="/app/stats"
              className="-mx-1.5 -my-3.5 flex items-center px-1.5 py-3.5 transition hover:text-foreground"
            >
              Stats
            </Link>
            <Link
              href="/app/account"
              className="-mx-1.5 -my-3.5 flex items-center px-1.5 py-3.5 transition hover:text-foreground"
            >
              Account
            </Link>
          </nav>

          <GenerateButton />
        </div>
      </header>

      {account && !account.isPremium && (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-negative/30 bg-negative/10 p-3 text-sm text-muted"
        >
          <strong className="text-negative">Not a Premium account</strong> —
          playback inside NextTrack needs Premium. Collecting listens and rating
          keep working.
        </p>
      )}

      {account?.reauthSoon && (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-accent/30 bg-accent/10 p-3 text-sm text-muted"
        >
          Spotify expires this authorization on{" "}
          {formatDate(account.reauthDueAt)} — you&apos;ll need to reconnect for
          collection to continue.
        </p>
      )}

      <RecoWorkspace groups={groups} />
    </main>
  );
}
