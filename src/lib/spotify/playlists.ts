import "server-only";

import { spotifyFetch } from "@/lib/spotify/client";
import {
  SpotifyApiError,
  SpotifyNotAllowlistedError,
} from "@/lib/spotify/errors";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Export d'une sélection de recommandations vers une playlist Spotify.
 *
 * Chemins retenus, relevés sur l'API réelle le 28/07/2026 (app en mode
 * développement, compte Premium allowlisté) :
 *
 *   POST /users/{user_id}/playlists  → 403   ✗
 *   POST /me/playlists               → 201   ✓ création
 *   POST /playlists/{id}/tracks      → 403   ✗
 *   POST /playlists/{id}/items       → 201   ✓ ajout
 *
 * ⚠️ NE PAS en conclure que les anciennes routes ont disparu — c'est faux, et
 * la nuance change le diagnostic. Vérifié sans jeton : Spotify renvoie 404 sur
 * un chemin inconnu (`GET /v1/playlists/{id}/zzzbogus` → 404 sans corps) et 401
 * « Valid access token required » sur un chemin existant. Or `/playlists/{id}/tracks`
 * comme `/users/{id}/playlists` répondent 401, donc ils EXISTENT toujours et
 * sont toujours routés. Leur 403 est un refus d'autorisation, pas une route
 * évanouie.
 *
 * Cause la plus probable de ce refus : `SPOTIFY_SCOPES` (scopes.ts) demande
 * `playlist-modify-private` mais PAS `playlist-modify-public`, alors que toute
 * relecture de la playlist renvoie `public: true`. Écrire dans une playlist
 * publique sans `playlist-modify-public` est exactement un 403. Tant que ce
 * point n'est pas tranché, considérer qu'un 403 peut revenir ici À TOUT MOMENT,
 * y compris sur `/items`.
 *
 * D'où le garde-fou de ce fichier : `spotifyFetch` traite TOUT 403 comme une
 * absence d'allowlist et bascule le compte en `needs_reauth` — ce qui casse
 * aussi la synchro, les recos et la lecture, et réclame à l'utilisateur une
 * reconnexion qui n'y changera rien. `requalifyForbidden` défait ce marquage
 * quand le 403 vient de la playlist et non du compte (même stratégie que
 * `playbackFailure` dans playback.ts).
 */

/**
 * Plafond d'URI par requête d'ajout. Vérifié : 101 URI renvoient
 * 400 « Too many ids requested ». D'où le découpage en lots.
 */
const MAX_URIS_PER_REQUEST = 100;

/** Description posée sur les playlists créées par l'app. */
const EXPORT_DESCRIPTION = "Selection exported from Rotation.";

/** La playlist référencée localement n'existe plus, ou n'appartient pas à l'utilisateur. */
export class PlaylistNotFoundError extends Error {
  constructor() {
    super("Playlist not found for this account.");
    this.name = "PlaylistNotFoundError";
  }
}

/**
 * Spotify a refusé l'écriture sur la playlist, alors que le compte est bien
 * autorisé sur l'application (sonde `/me` concluante).
 *
 * Distinguer ce cas de `SpotifyNotAllowlistedError` n'est pas cosmétique : ce
 * dernier fait basculer le compte en `needs_reauth` et affiche à l'utilisateur
 * une consigne d'allowlist qui ne le concerne pas.
 */
export class PlaylistForbiddenError extends Error {
  constructor() {
    super(
      "Spotify refused to modify this playlist. " +
        "The account is allowed on the app, so this is a restriction " +
        "specific to the playlist (write rights or missing scope " +
        "`playlist-modify-public` manquant).",
    );
    this.name = "PlaylistForbiddenError";
  }
}

type SpotifyPlaylist = {
  id?: string;
  name?: string;
  external_urls?: { spotify?: string };
};

/**
 * Vérifié : `external_urls.spotify` vaut toujours cette forme. On la reconstruit
 * pour les playlists réalimentées, dont on ne conserve que l'identifiant.
 */
function playlistUrl(playlistId: string): string {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

/**
 * Crée une playlist dans le compte de l'utilisateur.
 *
 * Privée par défaut : c'est le seul scope accordé (`playlist-modify-private`),
 * et c'est le comportement le moins surprenant — personne ne s'attend à voir
 * apparaître publiquement ce qu'une application lui a suggéré.
 *
 * À savoir si l'on relit une playlist : son champ `public` vaut `true` à la
 * relecture même quand elle a été créée avec `public: false`, et un
 * `PUT /playlists/{id}` explicite n'y change rien (vérifié). Ce champ n'est donc
 * pas exploitable pour afficher la visibilité. Le meilleur indice reste que la
 * création aboutit avec le seul scope `playlist-modify-private` : créer une
 * playlist publique exigerait `playlist-modify-public` et serait refusée.
 *
 * Le chemin ne prend plus l'identifiant Spotify de l'utilisateur : `/me` le
 * déduit du token. Inutile donc de lire `spotify_accounts.spotify_user_id`, la
 * variante `/users/{id}/playlists` répondant de toute façon 403.
 */
export async function createPlaylist(
  userId: string,
  {
    name,
    description,
    isPublic = false,
  }: { name: string; description?: string; isPublic?: boolean },
): Promise<{ id: string; url: string }> {
  const created = await spotifyFetch<SpotifyPlaylist>(userId, "/me/playlists", {
    method: "POST",
    body: {
      name,
      // Toujours envoyer une description, même vide : omettre le champ fait
      // enregistrer à Spotify la chaîne littérale « null », qui s'affiche telle
      // quelle dans son interface (vérifié).
      description: description ?? "",
      public: isPublic,
    },
  });

  if (!created?.id) {
    throw new Error("Spotify didn't return a playlist ID.");
  }

  return {
    id: created.id,
    url: created.external_urls?.spotify ?? playlistUrl(created.id),
  };
}

/**
 * Ajoute des morceaux à une playlist, par lots de 100 au maximum.
 *
 * Renvoie le nombre d'URI envoyées : Spotify ne dit pas ce qu'il a réellement
 * inséré. Il répond 201 même pour un identifiant fantaisiste, sans validation
 * par URI (vérifié) — il n'y a donc rien de plus fiable à retourner.
 */
export async function addTracksToPlaylist(
  userId: string,
  playlistId: string,
  trackIds: string[],
): Promise<number> {
  // Spotify accepte les doublons et les empile (vérifié) : une même sélection
  // envoyée deux fois produirait une playlist en double exemplaire.
  const uris = [...new Set(trackIds)].map((id) => `spotify:track:${id}`);
  if (uris.length === 0) return 0;

  let added = 0;

  for (let start = 0; start < uris.length; start += MAX_URIS_PER_REQUEST) {
    const chunk = uris.slice(start, start + MAX_URIS_PER_REQUEST);

    await spotifyFetch<{ snapshot_id: string }>(
      userId,
      `/playlists/${playlistId}/items`,
      { method: "POST", body: { uris: chunk } },
    );

    added += chunk.length;
  }

  return added;
}

export type ExportResult = {
  /** Identifiant Spotify, celui qu'il faut renvoyer pour réalimenter la playlist. */
  playlistId: string;
  url: string;
  added: number;
};

/**
 * Exporte une sélection : crée la playlist ou réalimente une playlist existante.
 *
 * `playlistId` est l'identifiant **Spotify** ; il doit correspondre à une ligne
 * de `public.playlists` appartenant à l'utilisateur. Refuser un identifiant
 * arbitraire évite qu'un client bricolé n'écrive dans n'importe quelle playlist
 * modifiable par le token.
 */
export async function exportRecommendations(
  userId: string,
  params: { trackIds: string[]; name: string; playlistId?: string },
): Promise<ExportResult> {
  try {
    return await runExport(userId, params);
  } catch (cause) {
    // Un 403 de l'API Playlists vient de traverser `spotifyFetch`, qui a marqué
    // le compte `needs_reauth` au passage. Trancher avant de propager.
    throw await requalifyForbidden(userId, cause);
  }
}

async function runExport(
  userId: string,
  {
    trackIds,
    name,
    playlistId,
  }: { trackIds: string[]; name: string; playlistId?: string },
): Promise<ExportResult> {
  const uniqueTrackIds = [...new Set(trackIds)];
  if (uniqueTrackIds.length === 0) {
    throw new Error("No track to export.");
  }

  const admin = createAdminClient();

  let existing: { name: string; track_count: number } | null = null;

  if (playlistId) {
    const { data } = await admin
      .from("playlists")
      .select("name, track_count")
      .eq("user_id", userId)
      .eq("spotify_playlist_id", playlistId)
      .maybeSingle();

    if (!data) throw new PlaylistNotFoundError();
    existing = data;
  }

  let targetId = playlistId ?? "";
  let url = playlistId ? playlistUrl(playlistId) : "";
  // Le nom local fait foi pour une playlist réalimentée : le renommer ici ne
  // renommerait rien chez Spotify et désynchroniserait les deux côtés.
  let targetName = existing?.name ?? name;
  let previousCount = existing?.track_count ?? 0;

  if (!playlistId) {
    const created = await createPlaylist(userId, {
      name,
      description: EXPORT_DESCRIPTION,
    });
    targetId = created.id;
    url = created.url;
  }

  let added: number;

  try {
    added = await addTracksToPlaylist(userId, targetId, uniqueTrackIds);
  } catch (cause) {
    // 404 : la playlist a disparu côté Spotify. Plutôt que d'échouer sur une
    // référence périmée, on repart sur une playlist neuve — l'utilisateur veut
    // ses morceaux, pas un message d'erreur.
    const gone =
      Boolean(playlistId) &&
      cause instanceof SpotifyApiError &&
      cause.status === 404;

    if (!gone) throw cause;

    await admin
      .from("playlists")
      .delete()
      .eq("user_id", userId)
      .eq("spotify_playlist_id", targetId);

    const created = await createPlaylist(userId, {
      name,
      description: EXPORT_DESCRIPTION,
    });
    targetId = created.id;
    url = created.url;
    targetName = name;
    previousCount = 0;

    added = await addTracksToPlaylist(userId, targetId, uniqueTrackIds);
  }

  const { error } = await admin.from("playlists").upsert(
    {
      user_id: userId,
      spotify_playlist_id: targetId,
      name: targetName,
      track_count: previousCount + added,
    },
    { onConflict: "user_id,spotify_playlist_id" },
  );

  if (error) throw new Error(`upsert playlists : ${error.message}`);

  await markExported(userId, uniqueTrackIds);

  return { playlistId: targetId, url, added };
}

/**
 * Requalifie un 403 de l'API Playlists.
 *
 * `spotifyFetch` transforme tout 403 en `SpotifyNotAllowlistedError` et bascule
 * le compte en `needs_reauth`. Sur ces endpoints, un 403 signifie tout aussi
 * bien « cette playlist n'est pas modifiable avec les scopes accordés » — et le
 * marquage casse alors la synchro, les recos et la lecture d'un compte qui va
 * parfaitement bien.
 *
 * On tranche avec une sonde sur `/me`, qui ne répond 403 que si le compte est
 * réellement hors allowlist. Coût : un appel, sur le seul chemin d'erreur.
 */
async function requalifyForbidden(
  userId: string,
  cause: unknown,
): Promise<unknown> {
  if (!(cause instanceof SpotifyNotAllowlistedError)) return cause;

  // Le statut doit être rétabli AVANT la sonde : `getValidAccessToken` refuse de
  // servir un token à un compte `needs_reauth`, et la sonde échouerait sur le
  // marquage qu'elle est justement censée vérifier. Le compte était forcément
  // `active` avant l'appel, pour la même raison.
  await clearNotAllowlisted(userId);

  try {
    await spotifyFetch<{ id: string }>(userId, "/me");
  } catch (probeCause) {
    // Nouveau 403 : le compte est bien hors allowlist, et `spotifyFetch` vient
    // de le re-marquer. Le diagnostic initial était bon.
    return probeCause;
  }

  return new PlaylistForbiddenError();
}

/** Annule un marquage `needs_reauth` posé à tort par un 403 de l'API Playlists. */
async function clearNotAllowlisted(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("spotify_accounts")
    .update({ status: "active", last_error: null })
    .eq("user_id", userId)
    // Ne ressuscite jamais un compte révoqué : on ne défait que ce marquage-là.
    .eq("status", "needs_reauth");
}

/**
 * Marque les recommandations exportées comme `served`.
 *
 * Choix de la valeur dans l'enum `reco_status` :
 *  - `rated` serait faux, aucune note n'a été donnée ;
 *  - `skipped` et `dismissed` sont des signaux NÉGATIFS, comptés en échecs par
 *    le bandit (`loadArmStats` dans reco/generate.ts) — or exporter un morceau
 *    est tout l'inverse d'un rejet ;
 *  - `pending` les ferait passer en `dismissed` à la prochaine génération, qui
 *    balaie les lots non consommés.
 * Reste `served` : « présentée à l'utilisateur », neutre pour l'apprentissage,
 * et qui sort la ligne du lot courant sans la salir.
 *
 * Seules les lignes encore `pending` sont modifiées : rétrograder une reco déjà
 * `rated` la ferait sortir de la vue `engine_performance` et fausserait la
 * comparaison des deux moteurs.
 */
async function markExported(userId: string, trackIds: string[]): Promise<void> {
  const admin = createAdminClient();

  const { error } = await admin
    .from("recommendations")
    .update({ status: "served", served_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("status", "pending")
    .in("track_id", trackIds);

  // L'export a réussi côté Spotify : un échec de marquage ne doit pas le faire
  // passer pour un échec. Il se corrigera au prochain lot.
  if (error) {
    console.error("marquage des recommandations exportées :", error.message);
  }
}

/**
 * Une playlist du compte dans laquelle l'utilisateur peut écrire.
 */
export type WritablePlaylist = {
  playlistId: string;
  name: string;
  /**
   * `null` quand le nombre de morceaux est inconnu.
   *
   * `/me/playlists` a cessé de renvoyer l'objet `tracks` (constaté le
   * 28/07/2026 : le champ est absent, pas vide). Le retrouver exigerait un
   * appel par playlist. On ne l'affiche donc que pour celles dont Rotation
   * tient le compte — mieux vaut ne rien dire qu'annoncer zéro.
   */
  trackCount: number | null;
  /** Vraie quand la playlist a été créée depuis Rotation. */
  fromRotation: boolean;
};

/** Spotify plafonne cet endpoint à 50 entrées par page. */
const PLAYLIST_PAGE = 50;

/**
 * Garde-fou de pagination. Une bibliothèque de plus de 500 playlists est assez
 * rare pour ne pas justifier d'épuiser un quota partagé entre tous les comptes
 * de l'application à chaque ouverture du panneau d'export.
 */
const MAX_PLAYLIST_PAGES = 10;

type SpotifyPlaylistPage = {
  items: {
    id: string;
    name: string;
    collaborative: boolean;
    owner: { id: string } | null;
    tracks: { total: number } | null;
  }[];
  next: string | null;
};

/**
 * Liste les playlists du compte où l'ajout est possible.
 *
 * Le filtre sur la propriété n'est pas cosmétique : `/me/playlists` renvoie
 * aussi celles qu'on suit sans les posséder, et y ajouter un morceau échoue en
 * 403. Les proposer reviendrait à offrir un bouton qui ne peut qu'échouer.
 *
 * Les playlists connues de Rotation sont remontées en tête : ce sont celles
 * qu'on alimente semaine après semaine, donc les cibles les plus probables.
 */
export async function listWritablePlaylists(
  userId: string,
  spotifyUserId: string,
): Promise<WritablePlaylist[]> {
  const admin = createAdminClient();
  const { data: known } = await admin
    .from("playlists")
    .select("spotify_playlist_id, track_count")
    .eq("user_id", userId);

  const countByPlaylist = new Map(
    (known ?? []).map((row) => [row.spotify_playlist_id, row.track_count]),
  );

  const collected: WritablePlaylist[] = [];

  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const body = await spotifyFetch<SpotifyPlaylistPage>(
      userId,
      `/me/playlists?limit=${PLAYLIST_PAGE}&offset=${page * PLAYLIST_PAGE}`,
    );

    if (!body) break;

    for (const item of body.items ?? []) {
      const mine = item.owner?.id === spotifyUserId;
      if (!mine && !item.collaborative) continue;

      collected.push({
        playlistId: item.id,
        name: item.name,
        trackCount: item.tracks?.total ?? countByPlaylist.get(item.id) ?? null,
        fromRotation: countByPlaylist.has(item.id),
      });
    }

    if (!body.next) break;
  }

  collected.sort((a, b) => {
    if (a.fromRotation !== b.fromRotation) return a.fromRotation ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return collected;
}
