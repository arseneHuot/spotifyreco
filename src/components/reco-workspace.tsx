"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { rateTrack } from "@/app/app/actions";
import { formatDayMonth } from "@/lib/format";
import { ExportPanel } from "@/components/export-panel";
import { StickyPlayer } from "@/components/sticky-player";

export type RecoItem = {
  trackId: string;
  name: string;
  artists: string;
  cover: string | null;
  engine: "algo" | "ai";
  exploration: number;
  explanation: string | null;
  tags: string[];
  rating: number | null;
  batchId: string;
};

export type RecoGroup = {
  id: string;
  name: string;
  kind: "manual" | "auto_daily" | "auto_refill";
  createdAt: string;
  items: RecoItem[];
};

const KIND_LABELS: Record<RecoGroup["kind"], string> = {
  manual: "Selection",
  auto_daily: "Daily",
  auto_refill: "Refill",
};

/** Une note affichée avant sa confirmation, avec la valeur qu'elle remplace. */
type PendingRating = { value: number; serverWas: number | null };

type EngineFilter = "all" | "algo" | "ai";

/** Filtre sur la notation : voir ce qui reste à juger, ou revenir sur ses avis. */
type RatingFilter = "all" | "unrated" | "rated" | "loved";

const RATING_FILTERS: [RatingFilter, string, string][] = [
  ["all", "All", "Every track in the group"],
  ["unrated", "To discover", "Not rated yet"],
  ["rated", "Rated", "The ones you've made up your mind about"],
  ["loved", "Favourites", "Rated 4 or 5"],
];

/**
 * Espace de travail : groupes à gauche, morceaux au centre, lecteur en bas.
 *
 * Un seul composant client porte l'état parce que les trois zones le partagent
 * — le morceau en cours doit être visible dans la liste *et* dans le lecteur,
 * et « suivant » dépend du filtre appliqué à la liste. Découper obligerait à
 * remonter cet état dans un contexte pour le redistribuer aussitôt.
 */
export function RecoWorkspace({ groups }: { groups: RecoGroup[] }) {
  const router = useRouter();

  const [activeId, setActiveId] = useState<string | null>(groups[0]?.id ?? null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [engineFilter, setEngineFilter] = useState<EngineFilter>("all");
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const group = groups.find((g) => g.id === activeId) ?? groups[0] ?? null;

  /**
   * Notes appliquées localement en attendant la confirmation du serveur.
   *
   * `router.refresh()` refait un aller-retour complet — une à deux secondes
   * pendant lesquelles le bouton resterait éteint. Or noter est l'acte central
   * de l'outil et il s'enchaîne au clavier : le retour doit être immédiat.
   */
  const [pendingRatings, setPendingRatings] = useState<
    Map<string, PendingRating>
  >(() => new Map());

  const items = useMemo(() => {
    const source = group?.items ?? [];
    if (pendingRatings.size === 0) return source;
    return source.map((item) => {
      const pending = pendingRatings.get(item.trackId);
      // L'attente ne vaut que tant que le serveur n'a pas bougé. Dès qu'il
      // renvoie autre chose que la valeur d'avant la note, c'est lui qui fait
      // foi : la confirmation attendue, ou un avis donné depuis un autre
      // appareil. La réconciliation est donc automatique, sans effet ni purge.
      if (!pending || pending.serverWas !== item.rating) return item;
      return { ...item, rating: pending.value };
    });
  }, [group, pendingRatings]);

  /** Les tags du groupe courant, classés par fréquence : les plus utiles d'abord. */
  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  }, [items]);

  function toggleTag(tag: string) {
    setTagFilters((chosen) => {
      const next = new Set(chosen);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  const filtersActive =
    engineFilter !== "all" || ratingFilter !== "all" || tagFilters.size > 0;

  function resetFilters() {
    setEngineFilter("all");
    setRatingFilter("all");
    setTagFilters(new Set());
  }

  const visible = useMemo(() => {
    return items.filter((item) => {
      // Le morceau en cours de lecture échappe aux filtres. Sans cela, le noter
      // sous « À découvrir » le ferait sortir de la liste sous ses propres
      // doigts : le lecteur se viderait et « suivant » perdrait sa position,
      // alors que la musique, elle, continue.
      if (item.trackId === currentId) return true;
      if (engineFilter !== "all" && item.engine !== engineFilter) return false;
      if (tagFilters.size > 0 && !item.tags.some((t) => tagFilters.has(t)))
        return false;
      if (ratingFilter === "unrated" && item.rating !== null) return false;
      if (ratingFilter === "rated" && item.rating === null) return false;
      if (ratingFilter === "loved" && (item.rating ?? 0) < 4) return false;
      return true;
    });
  }, [items, currentId, engineFilter, tagFilters, ratingFilter]);

  const current = visible.find((i) => i.trackId === currentId) ?? null;

  const handleDeviceReady = useCallback((id: string | null) => {
    setDeviceId(id);
  }, []);

  async function play(trackId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, deviceId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setNotice(payload.error ?? "Couldn't play");
        return;
      }
      setCurrentId(trackId);
    } catch {
      setNotice("Network unavailable");
    } finally {
      setBusy(false);
    }
  }

  /** Passe au morceau suivant **de la liste filtrée**, pas du groupe entier. */
  function playNext() {
    if (visible.length === 0) return;
    const index = visible.findIndex((i) => i.trackId === currentId);
    const next = visible[(index + 1) % visible.length];
    if (next) void play(next.trackId);
  }

  async function rate(trackId: string, value: number) {
    const serverWas = group?.items.find((i) => i.trackId === trackId)?.rating ?? null;
    setPendingRatings((current) =>
      new Map(current).set(trackId, { value, serverWas }),
    );
    try {
      await rateTrack({ trackId, rating: value });
      router.refresh();
    } catch {
      // L'écriture a échoué : retirer la note affichée plutôt que de laisser
      // croire à un avis enregistré. Le profil de goût ne doit rien inventer.
      setPendingRatings((current) => {
        const next = new Map(current);
        next.delete(trackId);
        return next;
      });
      setNotice("Rating not saved — try again");
    }
  }

  function toggle(trackId: string) {
    setSelected((chosen) => {
      const next = new Set(chosen);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
  }

  /**
   * Sélection en masse de ce qui est **affiché**, pas du groupe entier.
   *
   * Les filtres servent justement à isoler un sous-ensemble — « les coups de
   * cœur », « tout le rock » — et l'export en playlist en découle directement.
   * Sélectionner au-delà de ce qu'on voit produirait une playlist qu'on n'a
   * pas relue.
   *
   * Une sélection faite sous d'autres filtres n'est pas écrasée : on ajoute,
   * et on ne retire que ce qui est visible.
   */
  const allVisibleSelected =
    visible.length > 0 && visible.every((item) => selected.has(item.trackId));

  function toggleSelectVisible() {
    setSelected((chosen) => {
      const next = new Set(chosen);
      for (const item of visible) {
        if (allVisibleSelected) next.delete(item.trackId);
        else next.add(item.trackId);
      }
      return next;
    });
  }

  async function deleteGroup(id: string, label: string) {
    // Confirmation explicite : la suppression emporte les recommandations du
    // groupe. Les notes, elles, survivent — elles appartiennent à l'utilisateur.
    if (
      !window.confirm(
        `Delete “${label}”? Its suggested tracks go with it; your ratings are kept.`,
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/batches/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setNotice("Couldn't delete");
        return;
      }
      if (activeId === id) setActiveId(null);
      setSelected(new Set());
      router.refresh();
    } catch {
      setNotice("Network unavailable");
    } finally {
      setBusy(false);
    }
  }

  function onExported(message: string) {
    setNotice(message);
    setSelected(new Set());
  }

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-sm leading-relaxed text-muted">
        No selection yet. Your listens are syncing and the catalogue is filling
        out in the background; a selection is produced every morning. You can
        also ask for one right now.
      </p>
    );
  }

  return (
    // Sur mobile la colonne des groupes passe au-dessus de la liste et défile
    // horizontalement : en gardant deux colonnes côte à côte, ses 224 px fixes
    // ne laissaient qu'une centaine de pixels aux morceaux, qui débordaient de
    // l'écran.
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
      {/* ── Colonne des groupes ─────────────────────────────────────────── */}
      <aside
        className={`sm:shrink-0 sm:transition-all ${
          sidebarOpen ? "sm:w-56" : "sm:w-10"
        }`}
      >
        {/* Le repli n'a de sens que dans la mise en page en colonnes : sur
            mobile la bande horizontale ne dispute sa place à personne. */}
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? "Collapse the list" : "Expand the list"}
          className="mb-3 hidden h-8 w-8 items-center justify-center rounded-md border border-border text-muted transition hover:text-foreground sm:flex"
        >
          {sidebarOpen ? "‹" : "›"}
        </button>

        {sidebarOpen && (
          <nav
            className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:block sm:space-y-1.5 sm:overflow-visible sm:px-0"
            aria-label="Selections"
          >
            {groups.map((g) => {
              const isActive = g.id === group?.id;
              const cover = g.items.find((i) => i.cover)?.cover ?? null;

              return (
                <div
                  key={g.id}
                  className={`group/batch relative flex w-52 shrink-0 snap-start items-center rounded-lg border transition sm:w-full ${
                    isActive
                      ? "border-accent bg-accent/10"
                      : "border-border hover:bg-surface sm:border-transparent"
                  }`}
                >
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(g.id);
                    setSelected(new Set());
                    setTagFilters(new Set());
                    setRatingFilter("all");
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left"
                >
                  {cover ? (
                    <Image
                      src={cover}
                      alt=""
                      width={40}
                      height={40}
                      className="h-10 w-10 shrink-0 rounded object-cover"
                      unoptimized
                    />
                  ) : (
                    <span className="h-10 w-10 shrink-0 rounded bg-surface-hover" />
                  )}

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{g.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {KIND_LABELS[g.kind]} · {g.items.length} ·{" "}
                      {formatDayMonth(g.createdAt)}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => deleteGroup(g.id, g.name)}
                  disabled={busy}
                  aria-label={`Delete ${g.name}`}
                  title="Delete this selection"
                  // Toujours visible au doigt : sans survol sur mobile, un
                  // bouton révélé au hover est simplement inatteignable.
                  className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted transition hover:bg-negative/15 hover:text-negative focus-visible:opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover/batch:opacity-100"
                >
                  ×
                </button>
                </div>
              );
            })}
          </nav>
        )}
      </aside>

      {/* ── Morceaux ─────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 pb-36 sm:pb-28">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {(
            [
              ["all", "All"],
              ["algo", "In-house"],
              ["ai", "AI"],
            ] as [EngineFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setEngineFilter(value)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                engineFilter === value
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}

          <span className="mx-1 h-4 w-px bg-border" />

          {RATING_FILTERS.map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              onClick={() => setRatingFilter(value)}
              title={hint}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                ratingFilter === value
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {label}
              {value !== "all" && (
                <span className="ml-1 text-muted">
                  {
                    items.filter((i) =>
                      value === "unrated"
                        ? i.rating === null
                        : value === "rated"
                          ? i.rating !== null
                          : (i.rating ?? 0) >= 4,
                    ).length
                  }
                </span>
              )}
            </button>
          ))}

          {selected.size > 0 && (
            <ExportPanel
              trackIds={[...selected]}
              groupName={group?.name ?? null}
              onDone={onExported}
            />
          )}
        </div>

        {tagOptions.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {tagOptions.map(([tag, count]) => {
              const on = tagFilters.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleTag(tag)}
                  className={`rounded-full px-2.5 py-1 text-xs transition ${
                    on
                      ? "bg-accent text-background"
                      : "bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  {tag}
                  <span className={`ml-1 ${on ? "opacity-70" : "opacity-50"}`}>
                    {count}
                  </span>
                </button>
              );
            })}

            {tagFilters.size > 1 && (
              <span className="ml-1 text-xs text-muted">
                {tagFilters.size} genres combined
              </span>
            )}
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
          <span>
            {visible.length} track{visible.length === 1 ? "" : "s"}
            {filtersActive ? ` of ${items.length}` : ""}
          </span>

          {visible.length > 0 && (
            <button
              type="button"
              onClick={toggleSelectVisible}
              className="rounded-full border border-border px-2.5 py-0.5 transition hover:text-foreground"
            >
              {allVisibleSelected
                ? "Deselect all"
                : `Select all ${visible.length}`}
            </button>
          )}

          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-full border border-border px-2.5 py-0.5 transition hover:text-foreground"
            >
              Reset filters
            </button>
          )}
        </div>

        {notice && (
          <p className="mb-3 text-xs text-muted" role="status">
            {notice}
          </p>
        )}

        {visible.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
            No track matches these filters.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((item) => {
              const isCurrent = item.trackId === currentId;
              return (
                <li
                  key={item.trackId}
                  className={`group flex items-center gap-3 py-2.5 ${
                    isCurrent ? "bg-accent/5" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(item.trackId)}
                    onChange={() => toggle(item.trackId)}
                    aria-label={`Select ${item.name}`}
                    className="h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />

                  <button
                    type="button"
                    onClick={() => play(item.trackId)}
                    disabled={busy || !deviceId}
                    aria-label={`Play ${item.name}`}
                    className="relative h-11 w-11 shrink-0 overflow-hidden rounded disabled:opacity-50"
                  >
                    {item.cover ? (
                      <Image
                        src={item.cover}
                        alt=""
                        width={44}
                        height={44}
                        className="h-11 w-11 object-cover"
                        unoptimized
                      />
                    ) : (
                      <span className="block h-11 w-11 bg-surface-hover" />
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-background/60 text-sm opacity-0 transition group-hover:opacity-100">
                      {isCurrent ? "❚❚" : "▶"}
                    </span>
                  </button>

                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm ${isCurrent ? "text-accent" : ""}`}
                    >
                      {item.name}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {item.artists}
                      {item.tags.length > 0 && (
                        <span className="ml-2 opacity-70">
                          {item.tags.slice(0, 3).join(" · ")}
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {item.exploration > 0.5 && (
                      <span
                        className="text-xs text-accent"
                        title="A bet: outside your comfort zone"
                      >
                        ✦
                      </span>
                    )}
                    <span
                      className="text-[10px] uppercase tracking-wide text-muted"
                      title={
                        item.engine === "ai"
                          ? "Suggested by Claude, checked against MusicBrainz then Spotify"
                          : "Suggested by the in-house engine"
                      }
                    >
                      {item.engine === "ai" ? "AI" : "in-house"}
                    </span>
                    {item.rating !== null && (
                      <span className="w-5 text-right text-xs tabular-nums text-muted">
                        {item.rating}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {current?.explanation && (
          <p className="mt-4 rounded-lg border border-border bg-surface p-3 text-sm italic leading-relaxed text-muted">
            {current.explanation}
          </p>
        )}
      </div>

      <StickyPlayer
        current={current}
        onDeviceReady={handleDeviceReady}
        onRate={rate}
        onNext={playNext}
      />
    </div>
  );
}
