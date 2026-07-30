/**
 * Déclarations du Spotify Web Playback SDK.
 *
 * Le SDK est chargé par balise script et s'installe sur `window` : il n'existe
 * pas de paquet npm officiel, d'où ces déclarations manuelles limitées à ce que
 * l'application utilise réellement.
 */

export type SpotifyArtistRef = { name: string; uri: string };

export type SpotifyTrackRef = {
  id: string | null;
  uri: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtistRef[];
};

export type SpotifyPlayerState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: SpotifyTrackRef;
    previous_tracks: SpotifyTrackRef[];
    next_tracks: SpotifyTrackRef[];
  };
};

export type SpotifyPlayerError = { message: string };

export interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  togglePlay(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  getCurrentState(): Promise<SpotifyPlayerState | null>;

  addListener(
    event: "ready" | "not_ready",
    callback: (payload: { device_id: string }) => void,
  ): boolean;
  addListener(
    event: "player_state_changed",
    callback: (state: SpotifyPlayerState | null) => void,
  ): boolean;
  addListener(
    event:
      | "initialization_error"
      | "authentication_error"
      | "account_error"
      | "playback_error",
    callback: (error: SpotifyPlayerError) => void,
  ): boolean;

  removeListener(event: string): boolean;
}

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (callback: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}
