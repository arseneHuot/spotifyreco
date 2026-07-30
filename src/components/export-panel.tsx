"use client";

import { useEffect, useState } from "react";

type ExistingPlaylist = {
  playlistId: string;
  name: string;
  trackCount: number | null;
  /** Créée depuis NextTrack : remontée en tête et signalée. */
  fromNextTrack: boolean;
};

type Props = {
  /** Morceaux cochés, dans l'ordre de la liste affichée. */
  trackIds: string[];
  /** Nom du groupe courant : le nom par défaut d'une nouvelle playlist. */
  groupName: string | null;
  onDone: (message: string) => void;
};

/**
 * Export d'une sélection vers Spotify.
 *
 * Deux gestes distincts, qui ne se remplacent pas : verser dans une playlist
 * qu'on alimente au fil des semaines, ou en ouvrir une nouvelle. Le nom du
 * groupe est proposé d'emblée pour le second cas — c'est presque toujours
 * celui qu'on veut, puisque c'est la sélection qu'on vient de trier.
 *
 * Les playlists proposées sont celles créées par NextTrack, pas toutes celles
 * du compte : ce sont les seules dont on connaisse l'identifiant sans payer
 * une pagination complète de l'API Spotify sur un quota partagé.
 */
export function ExportPanel({ trackIds, groupName, onDone }: Props) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded-full bg-accent px-3 py-1 text-xs font-medium text-background transition hover:bg-accent-strong"
      >
        Export {trackIds.length} to Spotify
      </button>
    );
  }

  return (
    <ExportDialog
      // Remonter le panneau à chaque changement de groupe reinitialise le nom
      // propose sans effet de synchronisation.
      key={groupName ?? ""}
      trackIds={trackIds}
      groupName={groupName}
      onDone={onDone}
      onClose={() => setOpen(false)}
    />
  );
}

function ExportDialog({
  trackIds,
  groupName,
  onDone,
  onClose,
}: Props & { onClose: () => void }) {
  const [playlists, setPlaylists] = useState<ExistingPlaylist[] | null>(null);
  const [name, setName] = useState(groupName ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/playlists")
      .then((response) => (response.ok ? response.json() : { playlists: [] }))
      .then((payload: { playlists?: ExistingPlaylist[] }) => {
        if (!cancelled) setPlaylists(payload.playlists ?? []);
      })
      .catch(() => {
        if (!cancelled) setPlaylists([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const needle = search.trim().toLowerCase();
  const matching = (playlists ?? []).filter((playlist) =>
    needle ? playlist.name.toLowerCase().includes(needle) : true,
  );

  async function send(
    target: { playlistId?: string; name?: string },
    label: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds, ...target }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        added?: number;
        url?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "Couldn't export");
        return;
      }

      // La liste locale devient périmée : le compteur de morceaux a bougé, et
      // une création doit apparaître au prochain export.
      onClose();
      onDone(
        `${payload.added ?? trackIds.length} track(s) added to “${label}”.`,
      );
    } catch {
      setError("Network unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ml-auto w-full max-w-sm rounded-lg border border-border bg-surface p-3 text-left">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          Export {trackIds.length} track{trackIds.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="text-muted transition hover:text-foreground disabled:opacity-50"
        >
          ×
        </button>
      </div>

      {/* ── Nouvelle playlist ────────────────────────────────────────────── */}
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy && name.trim()) {
              void send({ name: name.trim() }, name.trim());
            }
          }}
          placeholder="New playlist name"
          disabled={busy}
          maxLength={100}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send({ name: name.trim() }, name.trim())}
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-background transition hover:bg-accent-strong disabled:opacity-50"
        >
          Create
        </button>
      </div>

      {/* ── Playlist existante ───────────────────────────────────────────── */}
      {playlists === null ? (
        <p className="mt-3 text-xs text-muted">Loading your playlists…</p>
      ) : playlists.length > 0 ? (
        <>
          <div className="mt-4 flex items-baseline justify-between gap-2">
            <p className="text-[11px] uppercase tracking-wide text-muted">
              or add to an existing one
            </p>
            <span className="text-[11px] text-muted">{playlists.length}</span>
          </div>

          {/* Au-delà d'une poignée de playlists, parcourir la liste coûte plus
              cher que taper deux lettres. */}
          {playlists.length > 6 && (
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter…"
              className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1 text-xs outline-none placeholder:text-muted focus:border-accent"
            />
          )}

          <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
            {matching.map((playlist) => (
              <li key={playlist.playlistId}>
                <button
                  type="button"
                  onClick={() =>
                    void send(
                      { playlistId: playlist.playlistId },
                      playlist.name,
                    )
                  }
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-surface-hover disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {playlist.name}
                    {playlist.fromNextTrack && (
                      <span
                        className="ml-1.5 text-[10px] uppercase tracking-wide text-accent"
                        title="Created from NextTrack"
                      >
                        ·R
                      </span>
                    )}
                  </span>
                  {playlist.trackCount !== null && (
                    <span className="shrink-0 tabular-nums text-muted">
                      {playlist.trackCount}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {matching.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted">
                No playlist matches “{search}”.
              </li>
            )}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted">
          No playlist created from NextTrack yet.
        </p>
      )}

      {busy && <p className="mt-3 text-xs text-muted">Sending to Spotify…</p>}
      {error && (
        <p className="mt-3 text-xs text-negative" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
