import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SpotifyApiError,
  SpotifyNotAllowlistedError,
} from "@/lib/spotify/errors";

/**
 * Mocks limités à la frontière du module : l'appel HTTP (`spotifyFetch`) et le
 * client d'administration. Le découpage en lots, la déduplication, la reprise
 * sur 404 et la requalification des 403 restent ceux de `playlists.ts`.
 */
type Chain = {
  select: () => Chain;
  upsert: (values: unknown) => Chain;
  update: (values: unknown) => Chain;
  delete: () => Chain;
  eq: (column: string, value: unknown) => Chain;
  in: (column: string, value: unknown) => Chain;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  then: (resolve: (result: { error: null }) => void) => void;
};

const { spotifyFetch, adminCalls, existingRow } = vi.hoisted(() => ({
  spotifyFetch: vi.fn(),
  adminCalls: [] as { table: string; op: string; payload?: unknown }[],
  existingRow: { current: null as unknown },
}));

vi.mock("@/lib/spotify/client", () => ({ spotifyFetch }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const record = (op: string, payload?: unknown): Chain => {
        adminCalls.push({ table, op, payload });
        return chain;
      };
      const chain: Chain = {
        select: () => record("select"),
        upsert: (values) => record("upsert", values),
        update: (values) => record("update", values),
        delete: () => record("delete"),
        eq: (column, value) => record(`eq:${column}`, value),
        in: (column, value) => record(`in:${column}`, value),
        maybeSingle: async () => ({ data: existingRow.current, error: null }),
        then: (resolve) => resolve({ error: null }),
      };
      return chain;
    },
  }),
}));

const { exportRecommendations, PlaylistForbiddenError, PlaylistNotFoundError } =
  await import("@/lib/spotify/playlists");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = "11111111-1111-1111-1111-111111111111";
const NEW_PLAYLIST = "4cOdK2wGLETKBW3PvgPWqT";

/** Identifiants base62 de 22 caractères, comme ceux que Spotify délivre. */
function trackIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(i).padStart(22, "a"),
  );
}

function urisSentTo(path: string): string[][] {
  return spotifyFetch.mock.calls
    .filter((call) => call[1] === path)
    .map((call) => (call[2] as { body: { uris: string[] } }).body.uris);
}

beforeEach(() => {
  vi.clearAllMocks();
  adminCalls.length = 0;
  existingRow.current = null;

  spotifyFetch.mockImplementation(async (_userId: string, path: string) => {
    if (path === "/me/playlists") {
      return {
        id: NEW_PLAYLIST,
        external_urls: {
          spotify: `https://open.spotify.com/playlist/${NEW_PLAYLIST}`,
        },
      };
    }
    if (path.endsWith("/items")) return { snapshot_id: "snap" };
    if (path === "/me") return { id: "spotify-user" };
    throw new Error(`chemin inattendu : ${path}`);
  });
});

// ---------------------------------------------------------------------------

describe("exportRecommendations", () => {
  it("crée la playlist puis y ajoute les morceaux dédoublonnés", async () => {
    const result = await exportRecommendations(USER, {
      trackIds: [...trackIds(3), ...trackIds(3)],
      name: "Rotation — test",
    });

    expect(result.playlistId).toBe(NEW_PLAYLIST);
    expect(result.added).toBe(3);

    const [uris] = urisSentTo(`/playlists/${NEW_PLAYLIST}/items`);
    expect(uris).toHaveLength(3);
    expect(uris.every((uri) => uri.startsWith("spotify:track:"))).toBe(true);
  });

  it("découpe en lots de 100 URI au maximum", async () => {
    const result = await exportRecommendations(USER, {
      trackIds: trackIds(150),
      name: "Rotation — test",
    });

    const batches = urisSentTo(`/playlists/${NEW_PLAYLIST}/items`);
    expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
    expect(result.added).toBe(150);
  });

  it("refuse un playlistId qui n'appartient pas à l'utilisateur", async () => {
    existingRow.current = null;

    await expect(
      exportRecommendations(USER, {
        trackIds: trackIds(1),
        name: "Rotation — test",
        playlistId: "7oIIrLcqQPCPmuLKMhxHTB",
      }),
    ).rejects.toBeInstanceOf(PlaylistNotFoundError);

    // Aucun appel réseau : le refus est tranché avant de dépenser du quota.
    expect(spotifyFetch).not.toHaveBeenCalled();
  });
});

describe("requalification des 403", () => {
  /**
   * Le cœur du garde-fou : `spotifyFetch` marque le compte `needs_reauth` sur
   * tout 403. Un 403 propre à la playlist ne doit pas déconnecter le compte ni
   * afficher la consigne d'allowlist.
   */
  it("rétablit le compte et renvoie PlaylistForbiddenError si /me répond", async () => {
    spotifyFetch.mockImplementation(async (_userId: string, path: string) => {
      if (path === "/me/playlists") return { id: NEW_PLAYLIST };
      if (path.endsWith("/items")) throw new SpotifyNotAllowlistedError();
      if (path === "/me") return { id: "spotify-user" };
      throw new Error(`chemin inattendu : ${path}`);
    });

    await expect(
      exportRecommendations(USER, {
        trackIds: trackIds(2),
        name: "Rotation — test",
      }),
    ).rejects.toBeInstanceOf(PlaylistForbiddenError);

    const restore = adminCalls.find(
      (call) => call.table === "spotify_accounts" && call.op === "update",
    );
    expect(restore?.payload).toEqual({ status: "active", last_error: null });

    // Le rétablissement ne doit viser que les comptes marqués `needs_reauth`,
    // jamais ressusciter un compte révoqué.
    expect(adminCalls).toContainEqual({
      table: "spotify_accounts",
      op: "eq:status",
      payload: "needs_reauth",
    });
  });

  it("laisse passer le diagnostic quand le compte est vraiment hors allowlist", async () => {
    spotifyFetch.mockImplementation(async (_userId: string, path: string) => {
      if (path === "/me/playlists") return { id: NEW_PLAYLIST };
      throw new SpotifyNotAllowlistedError();
    });

    await expect(
      exportRecommendations(USER, {
        trackIds: trackIds(2),
        name: "Rotation — test",
      }),
    ).rejects.toBeInstanceOf(SpotifyNotAllowlistedError);
  });

  it("ne requalifie pas les erreurs qui ne sont pas des 403", async () => {
    spotifyFetch.mockImplementation(async (_userId: string, path: string) => {
      if (path === "/me/playlists") return { id: NEW_PLAYLIST };
      throw new SpotifyApiError(500, path, "boom");
    });

    await expect(
      exportRecommendations(USER, {
        trackIds: trackIds(2),
        name: "Rotation — test",
      }),
    ).rejects.toBeInstanceOf(SpotifyApiError);

    // Pas de sonde `/me` inutile sur un chemin d'erreur qui ne la concerne pas.
    expect(spotifyFetch.mock.calls.some((call) => call[1] === "/me")).toBe(
      false,
    );
  });
});
