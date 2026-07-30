import "server-only";

import { sleep } from "@/lib/rate-limit";
import { getAccountSummary } from "@/lib/spotify/auth";
import { spotifyFetch } from "@/lib/spotify/client";
import {
  SpotifyApiError,
  SpotifyNotAllowlistedError,
  SpotifyReauthRequiredError,
} from "@/lib/spotify/errors";
import type { SpotifyCurrentlyPlaying } from "@/lib/spotify/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Commandes de lecture (Spotify Connect).
 *
 * Contrairement aux endpoints de catalogue, ceux du Player ne renvoient jamais
 * de corps en cas de succès (204) et encodent la vraie cause d'échec dans un
 * champ `reason` du corps d'erreur. Les trois cas qui arrivent réellement en
 * production sont traités ici, et un seul d'entre eux mérite une reprise :
 *
 *  - 404 `NO_ACTIVE_DEVICE` : aucun appareil actif. C'est le cas le plus
 *    fréquent, et il est structurel : le Web Playback SDK enregistre bien un
 *    appareil auprès de Spotify dès qu'il se connecte, mais celui-ci reste
 *    inactif tant que rien n'a été transféré dessus. Vérifié sur ce compte :
 *    `GET /me/player` répond 204 (donc « rien en cours ») alors que
 *    `GET /me/player/devices` liste deux appareils, tous deux `is_active:false`,
 *    et `PUT /me/player/play` répond alors 404 `NO_ACTIVE_DEVICE`.
 *    La reprise consiste donc à transférer la lecture puis à réessayer UNE fois.
 *  - 403 `PREMIUM_REQUIRED` : compte gratuit. Aucune reprise possible.
 *  - 403 `UNSUPPORTED` / restriction : morceau indisponible dans le pays.
 *
 * Piège majeur de `spotifyFetch` : il traite **tout** 403 comme une absence de
 * l'allowlist du dashboard développeur, et bascule le compte en `needs_reauth`
 * au passage. Sur les endpoints du Player, c'est faux une fois sur deux. D'où
 * les deux garde-fous ci-dessous : contrôle du produit *avant* l'appel, et
 * requalification du 403 *après* coup (voir `playbackFailure`).
 */

/**
 * Identifiant Spotify : 22 caractères en base 62.
 *
 * Le format est vérifié avant toute construction d'URI, et pas seulement par
 * hygiène : un identifiant qui contiendrait « : » permettrait de fabriquer un
 * URI d'un autre type (`spotify:episode:…`, `spotify:user:…:playlist:…`) et de
 * faire lire tout autre chose que le morceau demandé.
 */
const TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/**
 * Nombre d'URI acceptés par `PUT /me/player/play`. Au-delà, Spotify rejette la
 * requête entière : mieux vaut plafonner que perdre la lecture.
 */
const MAX_URIS = 100;

/**
 * Délai laissé à Spotify Connect entre le transfert et la commande de lecture.
 *
 * Le transfert est asynchrone côté Spotify : l'appareil n'est pas toujours
 * marqué actif au moment où le 204 revient, et un `play` immédiat peut
 * retomber sur le même 404.
 */
const DEVICE_SETTLE_MS = 400;

/**
 * Nom du device créé par le Web Playback SDK (voir `src/components/player.tsx`).
 * Sert de filet quand l'interface n'a pas transmis de `deviceId` : sans lui, la
 * lecture échouerait alors que l'appareil existe bel et bien côté Spotify.
 */
const NEXTTRACK_DEVICE_NAME = "NextTrack";

/** Appareil Spotify Connect. Forme relevée sur une réponse réelle. */
export type SpotifyPlaybackDevice = {
  id: string | null;
  is_active: boolean;
  is_private_session?: boolean;
  /** `true` quand l'appareil refuse les commandes de l'API Web. */
  is_restricted?: boolean;
  name: string;
  type?: string;
  volume_percent?: number | null;
  supports_volume?: boolean;
};

/** État de lecture complet : `/me/player` ajoute l'appareil au morceau en cours. */
export type PlaybackState = SpotifyCurrentlyPlaying & {
  device?: SpotifyPlaybackDevice | null;
  shuffle_state?: boolean;
  repeat_state?: string;
};

// ---------------------------------------------------------------------------
// Erreurs — chacune porte un message directement affichable par l'interface.
// ---------------------------------------------------------------------------

/** Identifiant de morceau vide, mal formé, ou d'un autre type que `track`. */
export class InvalidTrackIdError extends Error {
  constructor(readonly input: string) {
    super("Invalid track ID");
    this.name = "InvalidTrackIdError";
  }
}

/** Aucun appareil ne peut recevoir la lecture. */
export class NoActiveDeviceError extends Error {
  constructor() {
    super(
      "No active Spotify device. Open NextTrack in a tab and " +
        "wait for the player to be ready, or start Spotify on a device.",
    );
    this.name = "NoActiveDeviceError";
  }
}

/** Le compte n'est pas Premium : Spotify Connect lui est fermé. */
export class PremiumRequiredError extends Error {
  constructor() {
    super("Playing from NextTrack requires a Spotify Premium account.");
    this.name = "PremiumRequiredError";
  }
}

/** Morceau non lisible : indisponible dans le pays, ou retiré du catalogue. */
export class TrackUnavailableError extends Error {
  constructor() {
    super(
      "This track can't be played with your account " +
        "(unavailable in your country, or pulled from the catalogue).",
    );
    this.name = "TrackUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Construction des URI — pur, testable hors ligne
// ---------------------------------------------------------------------------

/**
 * Extrait un identifiant de morceau d'une saisie tolérante.
 *
 * Accepte l'identifiant nu, l'URI `spotify:track:…` et l'URL de partage
 * (y compris les variantes `/intl-fr/track/…` et le paramètre `?si=`), parce
 * que ces trois formes circulent indifféremment et qu'un copier-coller d'URL
 * est le moyen le plus simple de tester la route à la main.
 */
function normaliseTrackId(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  let id = raw;

  if (id.startsWith("spotify:track:")) {
    id = id.slice("spotify:track:".length);
  } else if (id.includes("/track/")) {
    id = id.slice(id.lastIndexOf("/track/") + "/track/".length);
  }

  const marker = id.search(/[?#]/);
  if (marker >= 0) id = id.slice(0, marker);

  if (!TRACK_ID_PATTERN.test(id)) throw new InvalidTrackIdError(raw);
  return id;
}

/** URI de lecture d'un morceau. Lève avant tout appel réseau si l'entrée est mauvaise. */
export function trackUri(input: string): string {
  return `spotify:track:${normaliseTrackId(input)}`;
}

/**
 * URI d'une file de lecture.
 *
 * La validation porte sur la liste entière *avant* le plafonnement : un
 * identifiant mal formé en position 150 trahit un bug appelant, et le masquer
 * ferait lire silencieusement autre chose que ce qui a été demandé.
 */
export function trackUris(inputs: readonly string[]): string[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new InvalidTrackIdError("");
  }
  return inputs.map(trackUri).slice(0, MAX_URIS);
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/** Lance un morceau, en transférant la lecture si nécessaire. */
export async function playTrack(
  userId: string,
  trackId: string,
  deviceId?: string,
): Promise<void> {
  await playTracks(userId, [trackId], deviceId);
}

/**
 * Lance une file de morceaux (le lot de recommandations, typiquement).
 *
 * Spotify remplace la file courante : les morceaux suivants s'enchaînent sans
 * autre appel, ce qui évite un aller-retour par piste.
 */
export async function playTracks(
  userId: string,
  trackIds: readonly string[],
  deviceId?: string,
): Promise<void> {
  // Validation d'abord : inutile de consommer du quota pour une saisie fausse.
  const uris = trackUris(trackIds);

  await assertPremium(userId);

  try {
    await sendPlay(userId, uris, deviceId);
    return;
  } catch (cause) {
    if (!isNoActiveDevice(cause)) throw await playbackFailure(userId, cause);
  }

  // À partir d'ici : 404, aucun appareil n'a pris la commande.
  const target = deviceId ?? (await findNextTrackDeviceId(userId));
  if (!target) throw new NoActiveDeviceError();

  // `play: false` : on veut activer l'appareil, pas reprendre ce qui traînait
  // dans la file précédente — c'est le `play` suivant qui décide du contenu.
  await transferPlayback(userId, target, false);
  await sleep(DEVICE_SETTLE_MS);

  try {
    // Une seule reprise : si l'appareil ne répond toujours pas, insister ne
    // fait que brûler un quota partagé par tous les utilisateurs.
    await sendPlay(userId, uris, target);
  } catch (cause) {
    if (isNoActiveDevice(cause)) throw new NoActiveDeviceError();
    throw await playbackFailure(userId, cause);
  }
}

/**
 * Bascule la lecture sur un appareil.
 *
 * Indispensable quand la lecture est active ailleurs : sans transfert, le
 * `PUT /play` joue sur l'appareil actif (le téléphone, l'enceinte) au lieu de
 * l'onglet NextTrack, ou échoue si aucun appareil n'est actif.
 */
export async function transferPlayback(
  userId: string,
  deviceId: string,
  play = true,
): Promise<void> {
  if (!deviceId) throw new NoActiveDeviceError();

  await assertPremium(userId);

  try {
    // 204 sans corps en cas de succès : `spotifyFetch` renvoie `null`, ce n'est
    // pas une erreur.
    await spotifyFetch<null>(userId, "/me/player", {
      method: "PUT",
      body: { device_ids: [deviceId], play },
    });
  } catch (cause) {
    // 404 ici = identifiant d'appareil inconnu de Spotify (onglet fermé, SDK
    // déconnecté). Le message « aucun appareil » est la bonne lecture pour
    // l'utilisateur.
    if (isNoActiveDevice(cause)) throw new NoActiveDeviceError();
    throw await playbackFailure(userId, cause);
  }
}

/**
 * État de lecture courant, ou `null` si rien ne joue.
 *
 * `GET /me/player` répond 204 sans corps dans ce cas — vérifié sur le compte de
 * production. `spotifyFetch` renvoie alors `null`, et ce n'est pas une erreur.
 */
export async function getPlaybackState(
  userId: string,
): Promise<PlaybackState | null> {
  return spotifyFetch<PlaybackState>(userId, "/me/player", {
    // Un 404 sur cet endpoint signifie la même chose qu'un 204 pour nous.
    allowNotFound: true,
  });
}

/**
 * Appareils Spotify Connect visibles par le compte.
 *
 * Vérifié : la liste contient les appareils inactifs, dont le device du Web
 * Playback SDK tant que rien ne lui a été transféré.
 */
export async function listDevices(
  userId: string,
): Promise<SpotifyPlaybackDevice[]> {
  const payload = await spotifyFetch<{ devices?: SpotifyPlaybackDevice[] }>(
    userId,
    "/me/player/devices",
  );
  return payload?.devices ?? [];
}

// ---------------------------------------------------------------------------
// Détails d'implémentation
// ---------------------------------------------------------------------------

async function sendPlay(
  userId: string,
  uris: string[],
  deviceId?: string,
): Promise<void> {
  // `encodeURIComponent` : l'identifiant vient du navigateur, il n'a pas à
  // pouvoir ajouter de paramètres à l'URL.
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  await spotifyFetch<null>(userId, `/me/player/play${query}`, {
    method: "PUT",
    body: { uris },
  });
}

/**
 * Repère le device du SDK quand l'appelant n'a pas transmis d'identifiant.
 *
 * Volontairement limité à l'appareil « NextTrack » : se rabattre sur le premier
 * appareil venu reviendrait à démarrer la musique sur le téléphone ou l'enceinte
 * de l'utilisateur, à son insu.
 */
async function findNextTrackDeviceId(userId: string): Promise<string | null> {
  const devices = await listDevices(userId);
  const rotation = devices.find(
    (device) => device.name === NEXTTRACK_DEVICE_NAME && device.id && !device.is_restricted,
  );
  return rotation?.id ?? null;
}

/**
 * 404 sur un endpoint du Player : aucun appareil utilisable.
 *
 * Le diagnostic porte sur le statut, pas sur le `reason` du corps, pour deux
 * raisons. D'abord `SpotifyApiError` tronque le corps à 200 caractères, et
 * Spotify le renvoie indenté — le champ `reason` est le dernier, donc le
 * premier perdu (corps réellement observé, 140 caractères :
 * `{\n  "error" : {\n    "status" : 404,\n    "message" : "Player command
 * failed: No active device found",\n    "reason" : "NO_ACTIVE_DEVICE"\n  }\n}`).
 * Ensuite, l'autre 404 du Player — « Device not found », device_id périmé —
 * appelle exactement le même traitement.
 */
function isNoActiveDevice(cause: unknown): boolean {
  return cause instanceof SpotifyApiError && cause.status === 404;
}

/**
 * Refuse la lecture aux comptes non Premium avant de dépenser du quota.
 *
 * Le contrôle a un second rôle, moins évident : sans lui, le 403 renvoyé par
 * Spotify ferait basculer le compte en `needs_reauth` (voir `playbackFailure`),
 * et l'utilisateur se verrait réclamer une reconnexion qui ne changerait rien.
 */
async function assertPremium(userId: string): Promise<void> {
  const summary = await getAccountSummary(userId);
  if (!summary) throw new SpotifyReauthRequiredError("aucun compte Spotify lié");

  // `product` peut être nul sur un compte lié avant que le champ ne soit
  // enregistré : dans le doute on laisse Spotify trancher.
  if (summary.product && !summary.isPremium) throw new PremiumRequiredError();
}

/**
 * Requalifie une erreur de commande de lecture.
 *
 * `spotifyFetch` transforme tout 403 en `SpotifyNotAllowlistedError` et marque
 * le compte `needs_reauth`. Sur le Player, un 403 signifie tout aussi bien
 * « morceau indisponible » : laisser passer ce diagnostic imposerait une
 * reconnexion complète à un utilisateur dont le compte va parfaitement bien.
 *
 * On tranche avec une sonde sur `/me`, qui répond 403 si et seulement si le
 * compte est réellement hors allowlist. Coût : un appel supplémentaire, sur le
 * seul chemin d'erreur.
 */
async function playbackFailure(
  userId: string,
  cause: unknown,
): Promise<unknown> {
  if (!(cause instanceof SpotifyNotAllowlistedError)) return cause;

  // Le statut doit être rétabli *avant* la sonde : `getValidAccessToken` refuse
  // de servir un token à un compte `needs_reauth`, et la sonde échouerait sur
  // le marquage qu'elle est censée vérifier. Le compte était forcément `active`
  // avant l'appel, pour la même raison — le rétablir est fidèle à l'état réel.
  await clearNotAllowlisted(userId);

  try {
    await spotifyFetch<{ id: string }>(userId, "/me");
  } catch (probeCause) {
    // Nouveau 403 : le compte est bien hors allowlist, et `spotifyFetch` vient
    // de le re-marquer. Le diagnostic initial était bon.
    if (probeCause instanceof SpotifyNotAllowlistedError) return probeCause;

    // La sonde n'a rien tranché (429 sur le quota partagé, 5xx, token expiré
    // entre-temps). Renvoyer *son* échec ferait afficher un diagnostic sans
    // rapport avec la commande de lecture — « Quota Spotify atteint » pour un
    // 403 sur un morceau. On garde l'erreur d'origine.
    return cause;
  }

  const summary = await getAccountSummary(userId);
  return summary && !summary.isPremium
    ? new PremiumRequiredError()
    : new TrackUnavailableError();
}

/** Annule un marquage `needs_reauth` posé à tort par un 403 du Player. */
async function clearNotAllowlisted(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("spotify_accounts")
    .update({ status: "active", last_error: null })
    .eq("user_id", userId)
    // Ne ressuscite jamais un compte révoqué : on ne défait que ce marquage-là.
    .eq("status", "needs_reauth");

  // Échouer ici laisse le compte en `needs_reauth` alors qu'il va bien : la
  // sonde qui suit échouera sur le marquage qu'elle devait vérifier, et
  // l'utilisateur se verra réclamer une reconnexion inutile. On ne peut rien
  // faire de mieux dans un chemin d'erreur, mais cela doit être diagnosticable.
  if (error) {
    console.error("rétablissement du statut Spotify :", error.message);
  }
}
