import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SpotifyApiError,
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
} from "@/lib/spotify/errors";

/**
 * Les mocks se limitent à la frontière du module : l'appel HTTP (`spotifyFetch`),
 * la lecture du compte et le client d'administration. Toute la logique testée —
 * validation, construction des URI, reprise après 404, requalification des 403 —
 * est bien celle de `playback.ts`.
 */
const { spotifyFetch, getAccountSummary, adminUpdate, adminEq } = vi.hoisted(
  () => ({
    spotifyFetch: vi.fn(),
    getAccountSummary: vi.fn(),
    adminUpdate: vi.fn(),
    adminEq: vi.fn(),
  }),
);

vi.mock("@/lib/spotify/client", () => ({ spotifyFetch }));
vi.mock("@/lib/spotify/auth", () => ({ getAccountSummary }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    // Chaîne PostgREST minimale : `.update().eq().eq()` doit rester « awaitable ».
    const chain = {
      update: (values: unknown) => {
        adminUpdate(values);
        return chain;
      },
      eq: (column: string, value: unknown) => {
        adminEq(column, value);
        return chain;
      },
      then: (resolve: (result: { error: null }) => void) =>
        resolve({ error: null }),
    };
    return { from: () => chain };
  },
}));

const {
  InvalidTrackIdError,
  NoActiveDeviceError,
  PremiumRequiredError,
  TrackUnavailableError,
  playTrack,
  playTracks,
  trackUri,
  trackUris,
  transferPlayback,
} = await import("@/lib/spotify/playback");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Identifiants réels (Daft Punk — One More Time) : 22 caractères base 62. */
const TRACK_A = "0DiWol3AO6WpXZgp0goxAV";
const TRACK_B = "1pKYYY0dkg23sQQXi0Q5zN";
const DEVICE_ID = "edadc069fd0afa010b006f4dd51ac8502a2cf82f";

function account(product: string | null) {
  return {
    spotifyUserId: "spotify-user",
    displayName: null,
    product,
    isPremium: product === "premium",
    status: "active" as const,
    authorizedAt: new Date(),
    reauthDueAt: new Date(Date.now() + 1000),
    reauthSoon: false,
  };
}

/** Corps réellement renvoyé par le Player quand aucun appareil n'est actif. */
function noActiveDevice(): SpotifyApiError {
  return new SpotifyApiError(
    404,
    "/me/player/play",
    JSON.stringify({
      error: {
        status: 404,
        message: "Player command failed: No active device found",
        reason: "NO_ACTIVE_DEVICE",
      },
    }),
  );
}

/** Chemin passé à `spotifyFetch` au n-ième appel. */
function pathOf(callIndex: number): string {
  return spotifyFetch.mock.calls[callIndex][1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccountSummary.mockResolvedValue(account("premium"));
  spotifyFetch.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Construction des URI
// ---------------------------------------------------------------------------

describe("trackUri", () => {
  it("construit l'URI depuis un identifiant nu", () => {
    expect(trackUri(TRACK_A)).toBe(`spotify:track:${TRACK_A}`);
  });

  it("accepte les formes qui circulent réellement", () => {
    const attendu = `spotify:track:${TRACK_A}`;

    expect(trackUri(`  ${TRACK_A}  `)).toBe(attendu);
    expect(trackUri(`spotify:track:${TRACK_A}`)).toBe(attendu);
    expect(trackUri(`https://open.spotify.com/track/${TRACK_A}`)).toBe(attendu);
    // Le paramètre `si=` est ajouté par le bouton « Partager ».
    expect(
      trackUri(`https://open.spotify.com/track/${TRACK_A}?si=8f1e2b3c4d5e6f70`),
    ).toBe(attendu);
    // Les URL localisées insèrent un segment avant `/track/`.
    expect(trackUri(`https://open.spotify.com/intl-fr/track/${TRACK_A}`)).toBe(
      attendu,
    );
  });

  it("rejette une entrée vide ou blanche", () => {
    expect(() => trackUri("")).toThrow(InvalidTrackIdError);
    expect(() => trackUri("   ")).toThrow(InvalidTrackIdError);
  });

  it("rejette un identifiant de longueur invalide", () => {
    expect(() => trackUri("A".repeat(21))).toThrow(InvalidTrackIdError);
    expect(() => trackUri("A".repeat(23))).toThrow(InvalidTrackIdError);
  });

  it("rejette les caractères hors base 62", () => {
    for (const mauvais of [
      "0DiWol3AO6WpXZgp0gox-V",
      "0DiWol3AO6WpXZgp0gox V",
      "0DiWol3AO6WpXZgp0gox/V",
      "0DiWol3AO6WpXZgp0gox+V",
    ]) {
      expect(() => trackUri(mauvais)).toThrow(InvalidTrackIdError);
    }
  });

  it("refuse de fabriquer un URI d'un autre type", () => {
    // Le point dur : un identifiant contenant « : » permettrait de faire lire
    // un épisode ou une playlist à la place du morceau demandé.
    expect(() => trackUri(`spotify:episode:${TRACK_A}`)).toThrow(
      InvalidTrackIdError,
    );
    expect(() => trackUri(`spotify:playlist:${TRACK_A}`)).toThrow(
      InvalidTrackIdError,
    );
    expect(() => trackUri(`${TRACK_A}:playlist:${TRACK_A}`)).toThrow(
      InvalidTrackIdError,
    );
    expect(() =>
      trackUri(`https://open.spotify.com/episode/${TRACK_A}`),
    ).toThrow(InvalidTrackIdError);
  });

  it("ne laisse jamais passer autre chose qu'un URI de morceau", () => {
    // Filet générique : quelle que soit l'entrée acceptée, la sortie a la forme
    // attendue par `PUT /me/player/play`.
    for (const entree of [
      TRACK_A,
      `spotify:track:${TRACK_B}`,
      `https://open.spotify.com/track/${TRACK_B}?si=x`,
    ]) {
      expect(trackUri(entree)).toMatch(/^spotify:track:[A-Za-z0-9]{22}$/);
    }
  });
});

describe("trackUris", () => {
  it("préserve l'ordre de la file", () => {
    expect(trackUris([TRACK_A, TRACK_B])).toEqual([
      `spotify:track:${TRACK_A}`,
      `spotify:track:${TRACK_B}`,
    ]);
  });

  it("rejette une liste vide", () => {
    expect(() => trackUris([])).toThrow(InvalidTrackIdError);
  });

  it("plafonne à 100 URI, limite de l'endpoint", () => {
    const beaucoup = Array.from({ length: 150 }, () => TRACK_A);
    const uris = trackUris(beaucoup);

    expect(uris).toHaveLength(100);
    expect(uris[99]).toBe(`spotify:track:${TRACK_A}`);
  });

  it("valide toute la liste avant de la plafonner", () => {
    // Un identifiant fautif au-delà du 100e doit échouer bruyamment : le
    // masquer ferait lancer une file différente de celle demandée.
    const liste = Array.from({ length: 150 }, (_, i) =>
      i === 149 ? "pas-un-identifiant" : TRACK_A,
    );

    expect(() => trackUris(liste)).toThrow(InvalidTrackIdError);
  });
});

// ---------------------------------------------------------------------------
// Garde-fous avant tout appel réseau
// ---------------------------------------------------------------------------

describe("validation avant appel réseau", () => {
  it("rejette un identifiant vide sans rien appeler", async () => {
    await expect(playTrack("user-1", "")).rejects.toThrow(InvalidTrackIdError);

    expect(spotifyFetch).not.toHaveBeenCalled();
    expect(getAccountSummary).not.toHaveBeenCalled();
  });

  it("rejette un identifiant mal formé sans rien appeler", async () => {
    await expect(playTrack("user-1", "spotify:track:trop-court")).rejects.toThrow(
      InvalidTrackIdError,
    );
    await expect(playTracks("user-1", [TRACK_A, "!!"])).rejects.toThrow(
      InvalidTrackIdError,
    );
    await expect(playTracks("user-1", [])).rejects.toThrow(InvalidTrackIdError);

    expect(spotifyFetch).not.toHaveBeenCalled();
  });

  it("refuse un compte non Premium sans consommer de quota", async () => {
    getAccountSummary.mockResolvedValue(account("free"));

    await expect(playTrack("user-1", TRACK_A)).rejects.toThrow(
      PremiumRequiredError,
    );
    expect(spotifyFetch).not.toHaveBeenCalled();
  });

  it("laisse passer un compte dont le produit est inconnu", async () => {
    // Compte lié avant l'enregistrement du champ : c'est Spotify qui tranche,
    // pas nous — sinon on bloquerait un Premium parfaitement valide.
    getAccountSummary.mockResolvedValue(account(null));

    await expect(playTrack("user-1", TRACK_A)).resolves.toBeUndefined();
    expect(spotifyFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

describe("playTracks", () => {
  it("envoie les URI sur l'appareil demandé", async () => {
    await playTracks("user-1", [TRACK_A, TRACK_B], DEVICE_ID);

    expect(spotifyFetch).toHaveBeenCalledTimes(1);
    expect(spotifyFetch).toHaveBeenCalledWith(
      "user-1",
      `/me/player/play?device_id=${DEVICE_ID}`,
      {
        method: "PUT",
        body: { uris: [`spotify:track:${TRACK_A}`, `spotify:track:${TRACK_B}`] },
      },
    );
  });

  it("omet device_id quand aucun appareil n'est imposé", async () => {
    await playTrack("user-1", TRACK_A);
    expect(pathOf(0)).toBe("/me/player/play");
  });

  it("échappe l'identifiant d'appareil dans l'URL", async () => {
    // L'identifiant vient du navigateur : il ne doit pas pouvoir greffer un
    // paramètre supplémentaire sur l'URL.
    await playTrack("user-1", TRACK_A, "abc&position_ms=99999");
    expect(pathOf(0)).toBe("/me/player/play?device_id=abc%26position_ms%3D99999");
  });
});

describe("reprise sur NO_ACTIVE_DEVICE", () => {
  it("transfère la lecture puis réessaie une fois", async () => {
    spotifyFetch
      .mockRejectedValueOnce(noActiveDevice()) // 1. play → 404
      .mockResolvedValueOnce(null) // 2. transfert
      .mockResolvedValueOnce(null); // 3. play (reprise)

    await playTrack("user-1", TRACK_A, DEVICE_ID);

    expect(spotifyFetch).toHaveBeenCalledTimes(3);
    expect(pathOf(1)).toBe("/me/player");
    expect(spotifyFetch.mock.calls[1][2]).toEqual({
      method: "PUT",
      // `play: false` : le transfert active l'appareil, il ne relance pas la
      // file précédente — c'est l'appel suivant qui choisit le contenu.
      body: { device_ids: [DEVICE_ID], play: false },
    });
    expect(pathOf(2)).toBe(`/me/player/play?device_id=${DEVICE_ID}`);
  });

  it("retrouve l'appareil NextTrack quand l'interface n'en fournit pas", async () => {
    spotifyFetch
      .mockRejectedValueOnce(noActiveDevice())
      .mockResolvedValueOnce({
        // Cas vérifié en production : des appareils existent, aucun n'est actif.
        devices: [
          { id: "autre", is_active: false, name: "MacBook Air" },
          { id: DEVICE_ID, is_active: false, name: "NextTrack" },
        ],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await playTrack("user-1", TRACK_A);

    expect(pathOf(1)).toBe("/me/player/devices");
    expect(spotifyFetch.mock.calls[2][2]).toEqual({
      method: "PUT",
      body: { device_ids: [DEVICE_ID], play: false },
    });
    expect(pathOf(3)).toBe(`/me/player/play?device_id=${DEVICE_ID}`);
  });

  it("ne démarre jamais la musique sur un appareil tiers", async () => {
    spotifyFetch.mockRejectedValueOnce(noActiveDevice()).mockResolvedValueOnce({
      devices: [{ id: "telephone", is_active: false, name: "iPhone d'Arsène" }],
    });

    await expect(playTrack("user-1", TRACK_A)).rejects.toThrow(
      NoActiveDeviceError,
    );
    expect(spotifyFetch).toHaveBeenCalledTimes(2);
  });

  it("ignore un appareil NextTrack restreint", async () => {
    spotifyFetch.mockRejectedValueOnce(noActiveDevice()).mockResolvedValueOnce({
      devices: [
        { id: DEVICE_ID, is_active: false, is_restricted: true, name: "NextTrack" },
      ],
    });

    await expect(playTrack("user-1", TRACK_A)).rejects.toThrow(
      NoActiveDeviceError,
    );
  });

  it("n'insiste pas au-delà d'une reprise", async () => {
    spotifyFetch
      .mockRejectedValueOnce(noActiveDevice()) // 1. play → 404
      .mockResolvedValueOnce(null) // 2. transfert accepté
      .mockRejectedValue(noActiveDevice()); // 3. reprise → 404, et au-delà

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toThrow(
      NoActiveDeviceError,
    );

    // play → transfert → play, et rien de plus : le quota est partagé par tous
    // les utilisateurs de l'application.
    expect(spotifyFetch).toHaveBeenCalledTimes(3);
  });

  it("abandonne dès que le transfert lui-même échoue", async () => {
    spotifyFetch.mockRejectedValue(noActiveDevice());

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toThrow(
      // Message actionnable : l'utilisateur doit savoir quoi faire.
      /No active Spotify device/,
    );

    // Un transfert refusé signifie que l'appareil n'existe plus côté Spotify :
    // relancer la lecture dessus n'a aucune chance d'aboutir.
    expect(spotifyFetch).toHaveBeenCalledTimes(2);
  });
});

describe("requalification des 403", () => {
  it("ne réclame pas de reconnexion quand le compte est bien autorisé", async () => {
    // `spotifyFetch` transforme tout 403 en « hors allowlist » et marque le
    // compte `needs_reauth` : sur le Player, c'est le plus souvent une simple
    // restriction sur le morceau.
    spotifyFetch
      .mockRejectedValueOnce(new SpotifyNotAllowlistedError())
      .mockResolvedValueOnce({ id: "spotify-user" }); // sonde /me → 200

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toThrow(
      TrackUnavailableError,
    );

    expect(pathOf(1)).toBe("/me");
    // Le marquage posé à tort doit être annulé, sinon l'utilisateur se voit
    // réclamer une réautorisation Spotify complète pour rien.
    expect(adminUpdate).toHaveBeenCalledWith({
      status: "active",
      last_error: null,
    });
    expect(adminEq).toHaveBeenCalledWith("status", "needs_reauth");
  });

  it("conclut au défaut de Premium si le compte n'est pas Premium", async () => {
    // Produit obsolète en base : le contrôle préalable a laissé passer, c'est
    // Spotify qui refuse.
    getAccountSummary
      .mockResolvedValueOnce(account(null))
      .mockResolvedValueOnce(account("free"));

    spotifyFetch
      .mockRejectedValueOnce(new SpotifyNotAllowlistedError())
      .mockResolvedValueOnce({ id: "spotify-user" });

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toThrow(
      PremiumRequiredError,
    );
  });

  it("maintient le diagnostic quand le compte est réellement hors allowlist", async () => {
    spotifyFetch
      .mockRejectedValueOnce(new SpotifyNotAllowlistedError())
      // La sonde échoue à son tour : `spotifyFetch` a re-marqué le compte.
      .mockRejectedValueOnce(new SpotifyNotAllowlistedError());

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toThrow(
      SpotifyNotAllowlistedError,
    );
  });

  it("garde l'erreur d'origine quand la sonde ne tranche pas", async () => {
    // La sonde partage le quota de tous les utilisateurs : elle peut échouer
    // pour une raison qui n'a rien à voir avec la lecture. Renvoyer *son* échec
    // afficherait « Quota Spotify atteint » pour un 403 sur un morceau.
    const original = new SpotifyNotAllowlistedError();
    spotifyFetch
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new SpotifyRateLimitError(30_000));

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toBe(original);
  });

  it("laisse remonter les erreurs qu'elle ne sait pas requalifier", async () => {
    const panne = new SpotifyApiError(502, "/me/player/play", "Bad gateway");
    spotifyFetch.mockRejectedValueOnce(panne);

    await expect(playTrack("user-1", TRACK_A, DEVICE_ID)).rejects.toBe(panne);
    // Aucune sonde : on ne dépense du quota que sur un 403.
    expect(spotifyFetch).toHaveBeenCalledTimes(1);
  });
});

describe("transferPlayback", () => {
  it("bascule la lecture sur l'appareil demandé", async () => {
    await transferPlayback("user-1", DEVICE_ID);

    expect(spotifyFetch).toHaveBeenCalledWith("user-1", "/me/player", {
      method: "PUT",
      body: { device_ids: [DEVICE_ID], play: true },
    });
  });

  it("traduit un appareil inconnu en absence d'appareil", async () => {
    spotifyFetch.mockRejectedValueOnce(
      new SpotifyApiError(404, "/me/player", "Device not found"),
    );

    await expect(transferPlayback("user-1", "obsolete")).rejects.toThrow(
      NoActiveDeviceError,
    );
  });

  it("refuse un identifiant d'appareil vide sans appeler Spotify", async () => {
    await expect(transferPlayback("user-1", "")).rejects.toThrow(
      NoActiveDeviceError,
    );
    expect(spotifyFetch).not.toHaveBeenCalled();
  });
});
