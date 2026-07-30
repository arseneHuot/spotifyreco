/**
 * Scopes demandés à Spotify.
 *
 * Ils sont demandés en une fois, au premier consentement : Spotify n'a pas de
 * mécanisme de consentement incrémental, et redemander un scope plus tard
 * impose de refaire passer l'utilisateur par l'écran d'autorisation.
 */
export const SPOTIFY_SCOPES = [
  // Identité — `user-read-private` donne le champ `product`, qui permet de
  // savoir si le compte est Premium et donc si le Web Playback SDK est utilisable.
  "user-read-email",
  "user-read-private",

  // Signaux de goût
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",

  // Lecture dans l'application
  "streaming",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",

  // Exporter une sélection vers une playlist Spotify.
  //
  // `playlist-modify-public` est indispensable dès lors qu'on propose
  // d'alimenter une playlist existante : Spotify crée les playlists en
  // `public: true` par défaut, et y écrire sans ce scope est un 403 — le refus
  // que ce projet a longtemps pris pour une absence d'allowlist.
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
] as const;

export const SPOTIFY_SCOPE_STRING = SPOTIFY_SCOPES.join(" ");
