import "server-only";

import { decrypt, encrypt } from "@/lib/crypto";
import { spotifyEnv } from "@/lib/env";
import { SpotifyReauthRequiredError } from "@/lib/spotify/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/lib/supabase/database.types";

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

/** Marge avant expiration : on rafraîchit un peu en avance plutôt que de
 *  découvrir l'expiration au milieu d'une série d'appels. */
const EXPIRY_MARGIN_MS = 60_000;

/** Durée de vie d'un refresh token Spotify, depuis l'autorisation initiale. */
const REFRESH_TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000; // ~6 mois

/** Seuil d'avertissement affiché à l'utilisateur avant la réautorisation. */
const REAUTH_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type SpotifyAccountSummary = {
  spotifyUserId: string;
  displayName: string | null;
  product: string | null;
  isPremium: boolean;
  status: "active" | "needs_reauth" | "revoked";
  authorizedAt: Date;
  reauthDueAt: Date;
  /** `true` quand la réautorisation des 6 mois approche. */
  reauthSoon: boolean;
};

/**
 * Enregistre les tokens issus du callback OAuth.
 *
 * Les provider tokens ne sont exposés par Supabase Auth qu'une seule fois, à
 * l'échange du code : ils ne sont ni stockés ni rafraîchis par Supabase, et ne
 * réapparaissent jamais sur un refresh de session. Rater cette fenêtre oblige
 * l'utilisateur à refaire une connexion Spotify complète.
 */
export async function storeTokensFromCallback(params: {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  profile: {
    id: string;
    email?: string | null;
    display_name?: string | null;
    product?: string | null;
    country?: string | null;
  };
  scopes: string[];
}): Promise<void> {
  const admin = createAdminClient();
  const now = new Date();

  const { error } = await admin.from("spotify_accounts").upsert(
    {
      user_id: params.userId,
      spotify_user_id: params.profile.id,
      email: params.profile.email ?? null,
      display_name: params.profile.display_name ?? null,
      product: params.profile.product ?? null,
      country: params.profile.country ?? null,
      access_token_enc: encrypt(params.accessToken),
      refresh_token_enc: encrypt(params.refreshToken),
      access_expires_at: new Date(
        now.getTime() + params.expiresIn * 1000,
      ).toISOString(),
      // Redémarre le compteur de 6 mois : c'est une autorisation neuve.
      authorized_at: now.toISOString(),
      scopes: params.scopes,
      status: "active",
      last_error: null,
      last_refreshed_at: now.toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw new Error(`Échec de l'enregistrement des tokens : ${error.message}`);
  }
}

/**
 * Renvoie un access token valide, en rafraîchissant si nécessaire.
 *
 * @throws {SpotifyReauthRequiredError} si le compte exige une réautorisation.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const admin = createAdminClient();

  const { data: account, error } = await admin
    .from("spotify_accounts")
    .select(
      "access_token_enc, refresh_token_enc, access_expires_at, authorized_at, status",
    )
    .eq("user_id", userId)
    .single();

  if (error || !account) {
    throw new SpotifyReauthRequiredError("aucun compte Spotify lié");
  }

  if (account.status !== "active") {
    throw new SpotifyReauthRequiredError(account.status);
  }

  const expiresAt = new Date(account.access_expires_at).getTime();
  if (expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return decrypt(account.access_token_enc);
  }

  // Ne pas tenter un refresh voué à l'échec : au-delà de 6 mois, Spotify
  // répond invalid_grant quoi qu'il arrive.
  const authorizedAt = new Date(account.authorized_at).getTime();
  if (Date.now() - authorizedAt > REFRESH_TOKEN_LIFETIME_MS) {
    await markNeedsReauth(userId, "refresh token expiré (6 mois)");
    throw new SpotifyReauthRequiredError("refresh token expiré (6 mois)");
  }

  return refreshAccessToken(userId, decrypt(account.refresh_token_enc));
}

/**
 * Échange un refresh token contre un nouvel access token.
 *
 * Deux jobs concurrents peuvent rafraîchir le même compte simultanément. C'est
 * sans danger ici : Spotify accepte plusieurs refresh successifs, et le dernier
 * écrit gagne. On persiste systématiquement le refresh token renvoyé quand il
 * est présent, car Spotify peut le faire tourner sans le documenter.
 */
async function refreshAccessToken(
  userId: string,
  refreshToken: string,
): Promise<string> {
  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = spotifyEnv();

  const basic = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });

  const body = await response.text();

  if (!response.ok) {
    // `invalid_grant` est terminal : le token est mort (expiré ou révoqué).
    // Réessayer ne fait que consommer du quota.
    if (response.status === 400 && body.includes("invalid_grant")) {
      await markNeedsReauth(userId, "invalid_grant");
      throw new SpotifyReauthRequiredError("invalid_grant");
    }
    throw new Error(`Échec du refresh Spotify (${response.status}) : ${body}`);
  }

  const payload = JSON.parse(body) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope?: string;
  };

  const admin = createAdminClient();
  const now = new Date();

  const update: TablesUpdate<"spotify_accounts"> = {
    access_token_enc: encrypt(payload.access_token),
    access_expires_at: new Date(
      now.getTime() + payload.expires_in * 1000,
    ).toISOString(),
    last_refreshed_at: now.toISOString(),
    last_error: null,
    // `authorized_at` n'est volontairement PAS mis à jour : un refresh ne
    // prolonge pas la fenêtre de 6 mois.
  };

  if (payload.refresh_token) {
    update.refresh_token_enc = encrypt(payload.refresh_token);
  }

  await admin.from("spotify_accounts").update(update).eq("user_id", userId);

  return payload.access_token;
}

async function markNeedsReauth(userId: string, reason: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("spotify_accounts")
    .update({ status: "needs_reauth", last_error: reason })
    .eq("user_id", userId);
}

/** Marque un compte comme non autorisé sur l'app (403 en mode développement). */
export async function markNotAllowlisted(userId: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("spotify_accounts")
    .update({
      status: "needs_reauth",
      last_error:
        "compte absent de l'allowlist du dashboard Spotify (5 utilisateurs max)",
    })
    .eq("user_id", userId);
}

/** État du compte Spotify, pour l'affichage. */
export async function getAccountSummary(
  userId: string,
): Promise<SpotifyAccountSummary | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("spotify_accounts")
    .select(
      "spotify_user_id, display_name, product, status, authorized_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return null;

  const authorizedAt = new Date(data.authorized_at);
  const reauthDueAt = new Date(
    authorizedAt.getTime() + REFRESH_TOKEN_LIFETIME_MS,
  );

  return {
    spotifyUserId: data.spotify_user_id,
    displayName: data.display_name,
    product: data.product,
    isPremium: data.product === "premium",
    status: data.status,
    authorizedAt,
    reauthDueAt,
    reauthSoon: reauthDueAt.getTime() - Date.now() < REAUTH_WARNING_MS,
  };
}
