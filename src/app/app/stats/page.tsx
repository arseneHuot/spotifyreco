import Link from "next/link";
import { redirect } from "next/navigation";

import { RatingTrend, type RatingPoint } from "@/components/rating-trend";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Bornes de l'échelle, réutilisées pour l'histogramme et la moyenne. */
const SCALE = [0, 1, 2, 3, 4, 5] as const;

const RATING_LABELS: Record<number, string> = {
  0: "Awful",
  1: "Don't like it",
  2: "Meh",
  3: "Decent",
  4: "Really good",
  5: "Exactly my thing",
};

export default async function StatsPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) redirect("/");

  const [{ data: ratings }, { data: listens }, { count: savedCount }, { data: recos }] =
    await Promise.all([
      supabase
        .from("ratings")
        // `updated_at` et non `created_at` : c'est la date de l'avis tel qu'il
        // est aujourd'hui. Renoter un morceau doit déplacer le point, sinon la
        // courbe attribue la note actuelle à une opinion révisée depuis.
        .select("track_id, rating, updated_at")
        .eq("user_id", user.id),
      supabase
        .from("listens")
        .select(
          "track_id, ms_played, played_at, tracks(name, track_artists(artists(name)), track_tags(tags(name)))",
        )
        .eq("user_id", user.id)
        .order("played_at", { ascending: false })
        .limit(2000),
      supabase
        .from("saved_tracks")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id),
      supabase
        .from("recommendations")
        .select("track_id, engine")
        .eq("user_id", user.id),
    ]);

  // --- Notes ----------------------------------------------------------------
  const histogram = new Map<number, number>(SCALE.map((v) => [v, 0]));
  for (const r of ratings ?? []) {
    histogram.set(r.rating, (histogram.get(r.rating) ?? 0) + 1);
  }
  const ratingCount = ratings?.length ?? 0;
  const ratingSum = (ratings ?? []).reduce((total, r) => total + r.rating, 0);
  const average = ratingCount > 0 ? ratingSum / ratingCount : null;
  const peak = Math.max(1, ...histogram.values());

  // --- Écoutes --------------------------------------------------------------
  // La durée écoutée n'est connue que pour les morceaux lancés depuis Rotation :
  // l'historique Spotify (`recently-played`) dit *ce qui* a été joué, jamais
  // combien de temps. Le total est donc annoncé avec sa couverture, faute de
  // quoi il se lit comme un temps d'écoute global et paraît absurdement bas.
  const totalMs = (listens ?? []).reduce((t, l) => t + (l.ms_played ?? 0), 0);
  const measured = (listens ?? []).filter((l) => (l.ms_played ?? 0) > 0).length;
  const distinctTracks = new Set((listens ?? []).map((l) => l.track_id)).size;

  const artistTime = new Map<string, { ms: number; plays: number }>();
  const tagCount = new Map<string, number>();

  for (const listen of listens ?? []) {
    const track = listen.tracks;
    const artist = track?.track_artists
      ?.map((link) => link.artists?.name)
      .find(Boolean);
    if (artist) {
      const entry = artistTime.get(artist) ?? { ms: 0, plays: 0 };
      entry.ms += listen.ms_played ?? 0;
      entry.plays += 1;
      artistTime.set(artist, entry);
    }
    for (const link of track?.track_tags ?? []) {
      const tag = link.tags?.name;
      if (tag) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    }
  }

  // Tri par nombre d'écoutes, pas par durée : la durée manque sur la majeure
  // partie de l'historique, si bien qu'un classement au temps ferait passer un
  // artiste écouté trois fois derrière un artiste écouté une seule.
  const topArtists = [...artistTime.entries()]
    .sort((a, b) => b[1].plays - a[1].plays || b[1].ms - a[1].ms)
    .slice(0, 8);
  const topArtistPlays = Math.max(1, ...topArtists.map(([, v]) => v.plays));

  const topTags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  // --- Comparaison des moteurs ---------------------------------------------
  // La question qui a motivé de faire tourner les deux moteurs côte à côte :
  // lequel produit les recommandations les mieux notées ? Seules les recos
  // effectivement notées comptent — les autres n'ont pas encore d'avis.
  const ratingByTrack = new Map((ratings ?? []).map((r) => [r.track_id, r.rating]));
  const engineStats = new Map<string, { rated: number; sum: number; total: number }>([
    ["algo", { rated: 0, sum: 0, total: 0 }],
    ["ai", { rated: 0, sum: 0, total: 0 }],
  ]);

  const engineByTrack = new Map<string, "algo" | "ai">();

  for (const reco of recos ?? []) {
    const entry = engineStats.get(reco.engine);
    if (!entry) continue;
    entry.total += 1;
    const rating = ratingByTrack.get(reco.track_id);
    if (rating !== undefined) {
      entry.rated += 1;
      entry.sum += rating;
    }
    // Les deux moteurs peuvent avoir proposé le même morceau dans des lots
    // différents. Le premier rencontré fait foi — les recommandations arrivent
    // du plus récent au plus ancien, donc c'est la proposition la plus récente.
    if (!engineByTrack.has(reco.track_id)) {
      engineByTrack.set(reco.track_id, reco.engine);
    }
  }

  const trendPoints: RatingPoint[] = (ratings ?? []).map((r) => ({
    at: r.updated_at,
    rating: r.rating,
    engine: engineByTrack.get(r.track_id) ?? null,
  }));

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
      <Link href="/app" className="text-sm text-muted hover:text-foreground">
        ← Back
      </Link>

      <h1 className="mt-6 text-2xl font-semibold">Stats</h1>
      <p className="mt-1 text-sm text-muted">
        What the engine actually knows about you.
      </p>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Listens" value={String(listens?.length ?? 0)} />
        <Metric
          label="Listening time"
          value={formatDuration(totalMs)}
          hint={
            measured === 0
              ? "not measured yet"
              : `measured on ${measured} of ${listens?.length ?? 0}`
          }
        />
        <Metric label="Ratings" value={String(ratingCount)} />
        <Metric
          label="Average rating"
          value={average === null ? "—" : average.toFixed(1)}
        />
        <Metric label="Distinct tracks" value={String(distinctTracks)} />
        <Metric label="Artists" value={String(artistTime.size)} />
        <Metric label="Liked tracks" value={String(savedCount ?? 0)} />
        <Metric label="Genres" value={String(tagCount.size)} />
      </section>

      {/* ── Distribution des notes ──────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="font-medium">Rating distribution</h2>
        {ratingCount === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No rating yet. Rate a few tracks from the player — the engine learns
            from what you reject as much as from what you love.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {SCALE.map((value) => {
              const count = histogram.get(value) ?? 0;
              const share = ratingCount > 0 ? (count / ratingCount) * 100 : 0;
              return (
                <li key={value} className="flex items-center gap-3 text-sm">
                  <span className="w-4 shrink-0 text-right font-mono tabular-nums">
                    {value}
                  </span>
                  <span className="w-20 shrink-0 truncate text-xs text-muted sm:w-32">
                    {RATING_LABELS[value]}
                  </span>
                  <span className="h-5 flex-1 overflow-hidden rounded bg-surface">
                    <span
                      className={`block h-full rounded ${
                        value <= 1 ? "bg-negative/70" : "bg-accent"
                      }`}
                      style={{ width: `${(count / peak) * 100}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted sm:w-16">
                    {count} · {Math.round(share)}%
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Évolution ───────────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="font-medium">Rating trend</h2>
        <p className="mt-1 text-xs text-muted">
          Average rating over time, engine by engine — is what you&apos;re
          offered getting better?
        </p>
        <RatingTrend points={trendPoints} />
      </section>

      {/* ── Moteurs ─────────────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="font-medium">Engine comparison</h2>
        <p className="mt-1 text-xs text-muted">
          Average rating of the tracks each engine suggested, counting only the
          ones you&apos;ve rated.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["algo", "In-house"],
              ["ai", "AI"],
            ] as const
          ).map(([key, label]) => {
            const stats = engineStats.get(key)!;
            const mean = stats.rated > 0 ? stats.sum / stats.rated : null;
            return (
              <div
                key={key}
                className="rounded-lg border border-border bg-surface p-4"
              >
                <p className="text-sm font-medium">{label}</p>
                <p className="mt-2 text-3xl font-semibold tabular-nums">
                  {mean === null ? "—" : mean.toFixed(1)}
                  {mean !== null && (
                    <span className="ml-1 text-sm font-normal text-muted">
                      / 5
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {stats.rated} rated out of {stats.total} suggested
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Artistes ────────────────────────────────────────────────────── */}
      {topArtists.length > 0 && (
        <section className="mt-10">
          <h2 className="font-medium">Most listened artists</h2>
          <p className="mt-1 text-xs text-muted">
            By play count. Time is shown when Rotation measured it.
          </p>
          <ul className="mt-4 space-y-2">
            {topArtists.map(([artist, { ms, plays }]) => (
              <li key={artist} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 truncate sm:w-40">{artist}</span>
                <span className="h-5 flex-1 overflow-hidden rounded bg-surface">
                  <span
                    className="block h-full rounded bg-accent/70"
                    style={{ width: `${(plays / topArtistPlays) * 100}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted sm:w-24">
                  {plays}×{ms > 0 ? ` · ${formatDuration(ms)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Genres ──────────────────────────────────────────────────────── */}
      {topTags.length > 0 && (
        <section className="mt-10">
          <h2 className="font-medium">Genres you listen to</h2>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {topTags.map(([tag, count]) => (
              <span
                key={tag}
                className="rounded-full bg-surface px-2.5 py-1 text-xs text-muted"
              >
                {tag}
                <span className="ml-1 opacity-50">{count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <footer className="mt-14 border-t border-border pt-6 text-xs text-muted">
        <Link href="/app/account" className="underline hover:text-foreground">
          My data and my account
        </Link>
      </footer>
    </main>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-tight text-muted">{hint}</p>}
    </div>
  );
}

/** « 3h 24m » — au-delà de l'heure, les minutes seules deviennent illisibles. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
