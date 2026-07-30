/**
 * Erreur terminale : l'utilisateur doit repasser par l'écran d'autorisation
 * Spotify. Aucun retry ne peut la résoudre.
 *
 * Deux causes possibles :
 *  - le refresh token a atteint ses 6 mois (Spotify les fait expirer depuis
 *    juillet 2026, à compter de l'autorisation initiale — le rafraîchir ne
 *    prolonge pas ce délai) ;
 *  - l'utilisateur a révoqué l'accès depuis son compte Spotify.
 */
export class SpotifyReauthRequiredError extends Error {
  constructor(readonly reason: string) {
    super(`Spotify reauthorization required: ${reason}`);
    this.name = "SpotifyReauthRequiredError";
  }
}

/**
 * L'utilisateur n'est pas dans l'allowlist du dashboard développeur.
 *
 * En mode développement, Spotify laisse l'OAuth réussir mais renvoie 403 sur
 * tout appel API. C'est le symptôme le plus déroutant du plafond de
 * 5 utilisateurs : la connexion « marche », et rien ne fonctionne ensuite.
 */
export class SpotifyNotAllowlistedError extends Error {
  constructor() {
    super(
      "This Spotify account isn't allowed on the app. " +
        "It has to be added in the Spotify developer dashboard " +
        "(Settings > Users Management), dans la limite de 5 utilisateurs.",
    );
    this.name = "SpotifyNotAllowlistedError";
  }
}

/** Quota d'appels dépassé — partagé par tous les utilisateurs de l'app. */
export class SpotifyRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Spotify rate limit reached, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "SpotifyRateLimitError";
  }
}

/** Erreur HTTP Spotify non catégorisée. */
export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    body: string,
  ) {
    super(`Spotify ${status} sur ${endpoint} : ${body.slice(0, 200)}`);
    this.name = "SpotifyApiError";
  }
}
