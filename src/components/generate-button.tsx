"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Engine = "algo" | "ai" | "both";

type Job = {
  id: string;
  status: "running" | "done" | "failed";
  engine: string;
  name: string | null;
  progress: number;
  step: string | null;
  batchId: string | null;
  error: string | null;
};

/** Intervalle de sondage : assez court pour voir bouger, assez long pour ne
 *  pas marteler la base pendant trois minutes. */
const POLL_MS = 2000;

/**
 * Le choix du moteur engage un coût et une attente très différents : le dire
 * explicitement évite de lancer une génération IA sans le savoir, ou de s'en
 * priver faute de comprendre à quoi elle sert.
 */
const ENGINE_OPTIONS: { value: Engine; label: string; hint: string }[] = [
  {
    value: "both",
    label: "Both",
    hint: "Half in-house engine, half AI — to compare them",
  },
  {
    value: "algo",
    label: "No AI",
    hint: "In-house engine only: instant and free",
  },
  {
    value: "ai",
    label: "With AI analysis",
    hint: "Claude studies your taste — 2 to 3 min, a few cents",
  },
];

/**
 * Génération manuelle d'un groupe de recommandations.
 *
 * La génération ne vit plus dans la requête : le serveur ouvre une tâche et
 * rend la main, le travail continue de son côté. Ce composant ne fait donc
 * qu'observer — ce qui change tout à l'usage, puisqu'on peut fermer le
 * panneau, naviguer, recharger, et retrouver la génération en cours.
 */
export function GenerateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [engine, setEngine] = useState<Engine>("both");
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Le rafraîchissement ne doit avoir lieu qu'au passage à « terminé », pas à
  // chaque sondage qui suit.
  const settled = useRef<string | null>(null);

  const readJob = useCallback(async (): Promise<Job | null> => {
    const response = await fetch("/api/recommend/status", {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { job: Job | null };
    return payload.job;
  }, []);

  /** Traduit une tâche achevée en message, et rafraîchit la liste. */
  const settle = useCallback(
    (finished: Job) => {
      if (settled.current === finished.id) return;
      settled.current = finished.id;

      if (finished.status === "failed") {
        setFailed(true);
        setMessage(finished.error ?? "Generation failed");
      } else if (finished.error && !finished.batchId) {
        // Terminée sans rien produire : c'est un échec du point de vue de qui
        // attendait une sélection.
        setFailed(true);
        setMessage(finished.error);
      } else if (finished.error) {
        // Un lot est bien arrivé, mais un moteur s'est tu : le dire sans
        // teinter l'ensemble en rouge.
        setFailed(false);
        setMessage(
          `${finished.name ? `“${finished.name}” is ready` : "Your selection is ready"} — ${finished.error}`,
        );
        setName("");
        setOpen(false);
      } else {
        setFailed(false);
        setMessage(
          finished.name
            ? `“${finished.name}” is ready`
            : "Your selection is ready",
        );
        setName("");
        setOpen(false);
      }

      router.refresh();
    },
    [router],
  );

  // Reprise et suivi. Au chargement, une génération lancée avant un
  // rechargement — ou depuis un autre onglet — est retrouvée telle quelle.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const current = await readJob().catch(() => null);
      if (cancelled) return;

      setJob(current);

      if (current?.status === "running") {
        timer = setTimeout(tick, POLL_MS);
      } else if (current) {
        settle(current);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `settle` et `readJob` sont stables ; ce sondage ne démarre qu'une fois.
  }, [readJob, settle]);

  const running = job?.status === "running";

  async function generate() {
    setStarting(true);
    setFailed(false);
    setMessage(null);

    try {
      const response = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine, name: name.trim() || undefined }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
        job?: Job;
      };

      if (!response.ok) {
        // 409 : une génération tourne déjà. Ce n'est pas un échec — on se
        // raccroche simplement à celle qui est en cours.
        if (response.status === 409 && payload.job) {
          setJob(payload.job);
          setOpen(false);
          return;
        }
        setFailed(true);
        setMessage(payload.error ?? "Generation failed");
        return;
      }

      settled.current = null;
      setOpen(false);
      setJob({
        id: payload.jobId ?? "pending",
        status: "running",
        engine,
        name: name.trim() || null,
        progress: 0,
        step: "Starting up",
        batchId: null,
        error: null,
      });

      // Reprendre le sondage sans attendre le prochain cycle.
      const poll = async () => {
        const current = await readJob().catch(() => null);
        if (!current) return;
        setJob(current);
        if (current.status === "running") setTimeout(poll, POLL_MS);
        else settle(current);
      };
      setTimeout(poll, POLL_MS);
    } catch {
      setFailed(true);
      setMessage("Network unavailable");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="text-right">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={running}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-background transition hover:bg-accent-strong disabled:opacity-50"
        >
          {running ? "Generating…" : "New selection"}
        </button>
      ) : (
        <div className="inline-flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-surface p-2">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !starting) void generate();
              if (event.key === "Escape") setOpen(false);
            }}
            placeholder="Selection name (optional)"
            autoFocus
            disabled={starting}
            className="w-56 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
          />

          <div
            role="radiogroup"
            aria-label="Recommendation engine"
            className="flex overflow-hidden rounded-full border border-border"
          >
            {ENGINE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={engine === option.value}
                onClick={() => setEngine(option.value)}
                disabled={starting}
                title={option.hint}
                className={`px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  engine === option.value
                    ? "bg-surface-hover text-foreground"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={generate}
            disabled={starting}
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-background transition hover:bg-accent-strong disabled:opacity-50"
          >
            {starting ? "Starting…" : "Generate"}
          </button>

          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={starting}
            className="px-2 py-1.5 text-xs text-muted transition hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {open && !starting && (
        <p className="mt-2 text-xs text-muted">
          {ENGINE_OPTIONS.find((o) => o.value === engine)?.hint}
        </p>
      )}

      {running && job && (
        <div className="ml-auto mt-3 w-full max-w-sm text-left">
          <div className="flex items-baseline justify-between gap-3">
            {/* Pas de région live : l'étape change chaque seconde pendant la
                vérification, ce qui ferait annoncer des dizaines de messages à
                un lecteur d'écran. La barre porte déjà `aria-valuenow`. */}
            <p className="min-w-0 truncate text-xs text-foreground">
              {job.step ?? "Working…"}
            </p>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
              {Math.round(job.progress * 100)}%
            </span>
          </div>

          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-hover"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(job.progress * 100)}
            aria-label="Generation progress"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(2, job.progress * 100)}%` }}
            />
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            Keeps running if you close this page — come back whenever.
          </p>
        </div>
      )}

      {message && !running && (
        <p
          className={`mt-2 max-w-md text-xs ${failed ? "text-negative" : "text-muted"}`}
          role={failed ? "alert" : "status"}
        >
          {message}
        </p>
      )}
    </div>
  );
}
