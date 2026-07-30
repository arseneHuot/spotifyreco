/**
 * Formes de réponse de l'API Spotify réellement utilisées.
 *
 * Volontairement partielles et tolérantes : depuis février 2026, Spotify retire
 * des champs des réponses en mode développement (`followers` et `popularity`
 * sur Artist, entre autres). Tout ce qui n'est pas indispensable est optionnel,
 * pour qu'une suppression côté Spotify dégrade le service sans le casser.
 */

export type SpotifyImage = {
  url: string;
  height?: number | null;
  width?: number | null;
};

export type SpotifySimplifiedArtist = {
  id: string;
  name: string;
};

export type SpotifyArtist = SpotifySimplifiedArtist & {
  images?: SpotifyImage[];
  /** Marqué « Deprecated » côté Spotify : présent aujourd'hui, pas demain. */
  genres?: string[];
  popularity?: number;
};

export type SpotifyAlbum = {
  id: string;
  name: string;
  images?: SpotifyImage[];
  release_date?: string;
  release_date_precision?: "year" | "month" | "day";
  total_tracks?: number;
};

export type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  explicit?: boolean;
  popularity?: number;
  album?: SpotifyAlbum;
  artists: SpotifySimplifiedArtist[];
  external_ids?: { isrc?: string };
  /** Marqué « Deprecated » et souvent nul depuis novembre 2024. */
  preview_url?: string | null;
};

export type SpotifyPlayHistoryItem = {
  track: SpotifyTrack;
  played_at: string;
  context?: { uri?: string; type?: string } | null;
};

export type SpotifySavedTrack = {
  added_at: string;
  track: SpotifyTrack;
};

export type SpotifyCurrentlyPlaying = {
  is_playing: boolean;
  progress_ms: number | null;
  timestamp?: number;
  item: SpotifyTrack | null;
  currently_playing_type?: string;
  context?: { uri?: string } | null;
};

export type SpotifyUserProfile = {
  id: string;
  display_name?: string | null;
  email?: string | null;
  /** « premium » | « free » | « open ». Le Web Playback SDK exige premium. */
  product?: string | null;
  country?: string | null;
  images?: SpotifyImage[];
};

/** Extrait l'année d'une date Spotify, dont la précision varie. */
export function releaseYear(album?: SpotifyAlbum): number | null {
  const raw = album?.release_date;
  if (!raw) return null;
  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

export function largestImage(images?: SpotifyImage[]): string | null {
  if (!images?.length) return null;
  return images.reduce((best, img) =>
    (img.width ?? 0) > (best.width ?? 0) ? img : best,
  ).url;
}
