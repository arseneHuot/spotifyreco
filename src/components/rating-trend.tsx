"use client";

import { useMemo, useState } from "react";

export type RatingPoint = {
  /** Date de l'avis, au format ISO. */
  at: string;
  rating: number;
  /** `null` quand la recommandation d'origine a été supprimée avec son groupe. */
  engine: "algo" | "ai" | null;
};

type Granularity = "week" | "month";

/**
 * La date est ramenée au fuseau d'écoute avant tout regroupement : sur un
 * serveur en UTC, une note donnée à 23 h 30 basculerait dans la semaine
 * suivante.
 */
const PARIS_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Lundi de la semaine contenant `ymd`, en YYYY-MM-DD. */
function weekKey(ymd: string): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // lundi = 0
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

const LABEL_WEEK = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const LABEL_MONTH = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

function periodLabel(key: string, granularity: Granularity): string {
  return granularity === "week"
    ? LABEL_WEEK.format(new Date(`${key}T00:00:00Z`))
    : LABEL_MONTH.format(new Date(`${key}-01T00:00:00Z`));
}

type Series = { key: string; label: string; average: number; count: number };

const SERIES_STYLE = {
  algo: { label: "In-house", colour: "var(--accent)" },
  ai: { label: "AI", colour: "var(--positive)" },
} as const;

/**
 * Évolution de la note moyenne, moteur par moteur.
 *
 * L'intérêt n'est pas la note d'un morceau mais la tendance : est-ce que ce
 * qu'on nous propose s'améliore ? Les deux moteurs sont donc tracés séparément
 * — c'est la seule lecture qui permette de les départager dans la durée, là où
 * une moyenne unique masquerait un moteur qui progresse et un qui décline.
 *
 * L'agrégation se fait ici plutôt que côté serveur : basculer entre semaine et
 * mois ne vaut pas un aller-retour réseau.
 */
export function RatingTrend({ points }: { points: RatingPoint[] }) {
  const [granularity, setGranularity] = useState<Granularity>("week");

  const { periods, byEngine } = useMemo(() => {
    const keyOf = (iso: string) => {
      const ymd = PARIS_YMD.format(new Date(iso));
      return granularity === "week" ? weekKey(ymd) : ymd.slice(0, 7);
    };

    // Somme et compte par (moteur, période), puis moyenne : garder les sommes
    // évite de recalculer sur des sous-ensembles.
    const buckets = new Map<string, Map<string, { sum: number; n: number }>>();
    const allKeys = new Set<string>();

    for (const point of points) {
      if (!point.engine) continue;
      const key = keyOf(point.at);
      allKeys.add(key);

      let engineBuckets = buckets.get(point.engine);
      if (!engineBuckets) {
        engineBuckets = new Map();
        buckets.set(point.engine, engineBuckets);
      }
      const cell = engineBuckets.get(key) ?? { sum: 0, n: 0 };
      cell.sum += point.rating;
      cell.n += 1;
      engineBuckets.set(key, cell);
    }

    const ordered = [...allKeys].sort();

    const series: Record<string, Series[]> = {};
    for (const [engine, engineBuckets] of buckets) {
      series[engine] = ordered
        .map((key) => {
          const cell = engineBuckets.get(key);
          if (!cell) return null;
          return {
            key,
            label: periodLabel(key, granularity),
            average: cell.sum / cell.n,
            count: cell.n,
          };
        })
        .filter((entry): entry is Series => entry !== null);
    }

    return { periods: ordered, byEngine: series };
  }, [points, granularity]);

  const rated = points.filter((p) => p.engine).length;

  if (rated === 0) {
    return (
      <p className="mt-3 text-sm text-muted">
        No rated recommendation yet. The trend appears once you&apos;ve judged a
        few.
      </p>
    );
  }

  // Géométrie du tracé. Le viewBox est fixe et le SVG s'étire : la courbe reste
  // lisible du mobile au bureau sans mesurer quoi que ce soit.
  const W = 320;
  const H = 120;
  const PAD = { left: 16, right: 6, top: 8, bottom: 18 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (index: number) =>
    periods.length <= 1
      ? PAD.left + plotW / 2
      : PAD.left + (index / (periods.length - 1)) * plotW;
  const y = (value: number) => PAD.top + (1 - value / 5) * plotH;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-full border border-border">
          {(
            [
              ["week", "Weekly"],
              ["month", "Monthly"],
            ] as [Granularity, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setGranularity(value)}
              className={`px-3 py-1 text-xs transition ${
                granularity === value
                  ? "bg-surface-hover text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-xs text-muted">
          {(["algo", "ai"] as const).map((engine) =>
            byEngine[engine]?.length ? (
              <span key={engine} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: SERIES_STYLE[engine].colour }}
                />
                {SERIES_STYLE[engine].label}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 h-40 w-full"
        role="img"
        aria-label="Average rating over time, by engine"
      >
        {/* Repères 0, 2.5 et 5 : suffisant pour situer sans quadriller. */}
        {[0, 2.5, 5].map((value) => (
          <g key={value}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 4}
              y={y(value) + 3}
              textAnchor="end"
              fontSize="7"
              fill="var(--muted)"
            >
              {value}
            </text>
          </g>
        ))}

        {(["algo", "ai"] as const).map((engine) => {
          const series = byEngine[engine];
          if (!series?.length) return null;
          const { colour } = SERIES_STYLE[engine];
          const path = series
            .map((entry) => {
              const index = periods.indexOf(entry.key);
              return `${x(index)},${y(entry.average)}`;
            })
            .join(" ");

          return (
            <g key={engine}>
              {series.length > 1 && (
                <polyline
                  points={path}
                  fill="none"
                  stroke={colour}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {series.map((entry) => {
                const index = periods.indexOf(entry.key);
                return (
                  <circle
                    key={entry.key}
                    cx={x(index)}
                    cy={y(entry.average)}
                    r="2.5"
                    fill={colour}
                  >
                    <title>
                      {`${SERIES_STYLE[engine].label} · ${entry.label} · ${entry.average.toFixed(1)}/5 on ${entry.count} rating${entry.count === 1 ? "" : "s"}`}
                    </title>
                  </circle>
                );
              })}
            </g>
          );
        })}

        {periods.map((key, index) => (
          <text
            key={key}
            x={x(index)}
            y={H - 4}
            textAnchor={
              periods.length === 1
                ? "middle"
                : index === 0
                  ? "start"
                  : index === periods.length - 1
                    ? "end"
                    : "middle"
            }
            fontSize="7"
            fill="var(--muted)"
          >
            {periodLabel(key, granularity)}
          </text>
        ))}
      </svg>

      {periods.length === 1 && (
        <p className="text-xs text-muted">
          A single {granularity === "week" ? "week" : "month"} so far — the trend
          will take shape as you keep rating.
        </p>
      )}
    </>
  );
}
