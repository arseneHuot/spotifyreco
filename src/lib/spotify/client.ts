import "server-only";

import { limiters, sleep } from "@/lib/rate-limit";
import { getValidAccessToken, markNotAllowlisted } from "@/lib/spotify/auth";
import {
  SpotifyApiError,
  SpotifyNotAllowlistedError,
  SpotifyRateLimitError,
} from "@/lib/spotify/errors";

/**
 * Au-delà, on ne fait plus la queue : les pauses réelles imposées par un 429
 * de Spotify se comptent en heures, pas en secondes.
 */
const MAX_PAUSE_WAIT_MS = 20_000;

const API_BASE = "https://api.spotify.com/v1";

/** Nombre de tentatives sur erreur transitoire (429, 5xx). */
const MAX_RETRIES = 3;

/**
 * Plafond d'attente accepté sur un 429. Au-delà, on abandonne le job plutôt que
 * de bloquer une fonction serverless : Vercel coupe à 300 s, et une fonction qui
 * dort est facturée en mémoire pendant tout ce temps.
 */
const MAX_RETRY_AFTER_MS = 60_000;

type FetchOptions = {
  method?: string;
  body?: unknown;
  /** Considérer un 404 comme une absence plutôt qu'une erreur. */
  allowNotFound?: boolean;
};

/**
 * Appelle l'API Spotify pour le compte d'un utilisateur.
 *
 * Prend en charge le rafraîchissement du token, le débit sortant et les erreurs
 * propres au mode développement.
 */
export async function spotifyFetch<T>(
  userId: string,
  path: string,
  options: FetchOptions = {},
): Promise<T | null> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Quand un 429 a suspendu le limiteur pour des heures, attendre dans la
    // file serait pire qu'échouer : une génération restait suspendue à 3 % le
    // temps que la pause s'écoule, sans le moindre signe de vie. On échoue
    // net avec le délai réel, que chaque appelant sait déjà traduire.
    const pausedForMs = limiters.spotify.pausedForMs;
    if (pausedForMs > MAX_PAUSE_WAIT_MS) {
      throw new SpotifyRateLimitError(pausedForMs);
    }

    await limiters.spotify.acquire();

    const accessToken = await getValidAccessToken(userId);

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });

    // 204 : pas de contenu. Réponse normale de /me/player quand rien ne joue.
    if (response.status === 204) return null;

    if (response.ok) {
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : null;
    }

    if (response.status === 404 && options.allowNotFound) return null;

    if (response.status === 401) {
      // Le token vient d'être invalidé côté Spotify. `getValidAccessToken` en
      // redemandera un au tour suivant. Une seule reprise : si le second essai
      // échoue aussi, le problème n'est pas l'expiration.
      if (attempt === 0) continue;
      throw new SpotifyApiError(401, path, await response.text());
    }

    if (response.status === 403) {
      const body = await response.text();

      // Un 403 ne signifie pas forcément que le compte est hors allowlist :
      // le Player en renvoie un pour un morceau indisponible dans le pays ou
      // une action réservée à Premium, et l'API Playlists pour un endpoint
      // retiré. Marquer le compte `needs_reauth` dans ces cas déconnecterait
      // l'utilisateur alors que son autorisation est parfaitement valide.
      //
      // La distinction est nette : une exclusion d'allowlist frappe *tous* les
      // endpoints, `/me` compris. Si `/me` répond, le compte est autorisé et le
      // refus vient de l'action demandée.
      if (await isStillAllowlisted(accessToken)) {
        throw new SpotifyApiError(403, path, body);
      }

      await markNotAllowlisted(userId);
      throw new SpotifyNotAllowlistedError();
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));

      // Le quota étant décompté par compte développeur, la pause doit valoir
      // pour tous les utilisateurs, pas seulement pour celui qui a déclenché
      // le dépassement.
      limiters.spotify.pauseFor(retryAfterMs);

      if (retryAfterMs > MAX_RETRY_AFTER_MS || attempt === MAX_RETRIES) {
        throw new SpotifyRateLimitError(retryAfterMs);
      }
      await sleep(retryAfterMs);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(2 ** attempt * 500);
      continue;
    }

    throw new SpotifyApiError(response.status, path, await response.text());
  }

  throw new SpotifyApiError(0, path, "nombre maximal de tentatives atteint");
}

/**
 * Vérifie que le compte est toujours autorisé sur l'application.
 *
 * Appel direct plutôt que via `spotifyFetch` : ce dernier traite les 403, et
 * l'appeler ici partirait en récursion. En cas de doute (réseau, timeout) on
 * répond `true` — mieux vaut laisser passer un 403 que déconnecter à tort un
 * utilisateur dont l'autorisation est valide.
 */
async function isStillAllowlisted(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return response.status !== 403;
  } catch {
    return true;
  }
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Spotify renvoie parfois 0 : on garde un plancher pour ne pas repartir
    // immédiatement dans le mur.
    return Math.max(seconds, 1) * 1000;
  }
  return 5_000;
}

/**
 * Parcourt un endpoint paginé et renvoie tous les éléments.
 *
 * `maxItems` est un garde-fou : sans lui, une bibliothèque de 20 000 morceaux
 * consommerait 400 requêtes et dépasserait le temps d'exécution d'une fonction.
 */
export async function spotifyPaginate<T>(
  userId: string,
  path: string,
  { maxItems = 1000, limit = 50 }: { maxItems?: number; limit?: number } = {},
): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  let next: string | null = `${path}${separator}limit=${limit}`;

  while (next && items.length < maxItems) {
    const page: { items: T[]; next: string | null } | null =
      await spotifyFetch<{ items: T[]; next: string | null }>(userId, next);

    if (!page?.items?.length) break;

    items.push(...page.items);
    next = page.next;
  }

  return items.slice(0, maxItems);
}
