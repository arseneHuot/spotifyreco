"use client";

import Image from "next/image";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RecoItem } from "@/components/reco-workspace";
import type { SpotifyPlayer, SpotifyPlayerState } from "@/types/spotify-sdk";

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";

/** En dessous, l'écoute est trop courte pour valoir un signal. */
const MIN_MEANINGFUL_MS = 30_000;

/** mm:ss — le format attendu par tout le monde sur un lecteur. */
function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const RATING_LABELS = [
  "Awful",
  "Don't like it",
  "Meh",
  "Decent",
  "Really good",
  "Exactly my thing",
] as const;

type Props = {
  current: RecoItem | null;
  onDeviceReady: (deviceId: string | null) => void;
  onRate: (trackId: string, rating: number) => void | Promise<void>;
  onNext: () => void;
};

/**
 * Lecteur fixé en bas de l'écran.
 *
 * Il porte la notation parce que c'est le moment où l'avis se forme : noter
 * pendant l'écoute, sans quitter la liste ni chercher la ligne concernée. Le
 * raccourci clavier 0-5 vise donc toujours le morceau en cours, quel que soit
 * l'endroit de la page où l'on se trouve.
 */
export function StickyPlayer({ current, onDeviceReady, onRate, onNext }: Props) {
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // Retour visuel de la notation. La clé change à chaque note pour relancer
  // l'animation même quand on reclique la même valeur.
  const [burst, setBurst] = useState<{ value: number; key: number } | null>(null);

  // Le morceau courant est lu dans des gestionnaires d'événements enregistrés
  // une seule fois : passer par une ref évite de les réenregistrer à chaque
  // changement de piste, ce qui rebrancherait le SDK en boucle. La ref est
  // alimentée dans un effet — l'écrire pendant le rendu est un anti-pattern
  // que React signale à juste titre.
  const currentRef = useRef<RecoItem | null>(null);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Même raison pour `onNext` : le gestionnaire d'état du SDK est enregistré
  // une seule fois, la ref lui donne toujours la version courante.
  const onNextRef = useRef(onNext);

  useEffect(() => {
    onNextRef.current = onNext;
  }, [onNext]);

  // Détection de fin de piste. Le SDK n'émet aucun événement dédié : la fin se
  // reconnaît à sa signature — le morceau jouait, puis pause à la position 0.
  // `handledFor` évite d'enchaîner deux fois sur la même fin, le SDK émettant
  // volontiers plusieurs états identiques coup sur coup.
  const lastStateRef = useRef<{
    trackId: string | null;
    paused: boolean;
    position: number;
  } | null>(null);
  const endedForRef = useRef<string | null>(null);
  const lastAdvanceRef = useRef(0);

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const response = await fetch("/api/spotify/token", { cache: "no-store" });
    if (!response.ok) {
      setError(
        response.status === 401
          ? "You need to reconnect to Spotify."
          : "Playback token unavailable.",
      );
      return null;
    }
    const payload = (await response.json()) as { accessToken: string };
    return payload.accessToken;
  }, []);

  const initialise = useCallback(() => {
    if (playerRef.current || !window.Spotify) return;

    const player = new window.Spotify.Player({
      name: "Rotation",
      getOAuthToken: (callback) => {
        void fetchToken().then((token) => token && callback(token));
      },
      volume: 0.7,
    });

    player.addListener("ready", ({ device_id }) => {
      setReady(true);
      setError(null);
      onDeviceReady(device_id);
    });

    player.addListener("not_ready", () => {
      setReady(false);
      onDeviceReady(null);
    });

    player.addListener("account_error", () =>
      setError("Playback requires a Spotify Premium account."),
    );
    player.addListener("authentication_error", () =>
      setError("Spotify authentication refused."),
    );
    player.addListener("initialization_error", ({ message }) =>
      setError(`Player unavailable: ${message}`),
    );

    player.addListener("player_state_changed", (state: SpotifyPlayerState | null) => {
      if (!state) return;
      setPaused(state.paused);
      setPosition(state.position);
      setDuration(state.duration);

      const trackId = state.track_window?.current_track?.id ?? null;
      const previous = lastStateRef.current;
      lastStateRef.current = {
        trackId,
        paused: state.paused,
        position: state.position,
      };

      if (!state.paused) {
        // La fin ne redevient consommable qu'après deux secondes de lecture
        // avérée : au démarrage d'un morceau, le SDK émet des états « joue »
        // à la position quasi nulle pendant la mise en mémoire, et les
        // prendre pour une lecture réelle réarmait la détection aussitôt.
        if (state.position > 2000) endedForRef.current = null;
        return;
      }

      // Fin de piste, et non pause manuelle ni hoquet de démarrage. Une pause
      // volontaire conserve sa position. Le hoquet, lui, produit exactement la
      // signature d'une fin — « jouait, puis arrêté à zéro » — mais depuis une
      // position infime : mesuré en production, il enchaînait un second saut
      // quatre secondes après le premier. D'où le plancher sur la position.
      const ended =
        previous !== null &&
        previous.trackId === trackId &&
        !previous.paused &&
        previous.position > 2000 &&
        state.position === 0;

      // Garde-fou final : jamais deux sauts en moins de quatre secondes, quoi
      // que racontent les états du SDK.
      if (
        ended &&
        endedForRef.current !== trackId &&
        Date.now() - lastAdvanceRef.current > 4000
      ) {
        endedForRef.current = trackId;
        lastAdvanceRef.current = Date.now();
        onNextRef.current();
      }
    });

    void player.connect();
    playerRef.current = player;
  }, [fetchToken, onDeviceReady]);

  useEffect(() => {
    window.onSpotifyWebPlaybackSDKReady = initialise;
    if (window.Spotify) initialise();
    return () => {
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, [initialise]);

  // Le SDK n'émet pas d'événement continu : sans cette horloge locale, la barre
  // de progression resterait figée entre deux changements d'état.
  //
  // Cette horloge sert aussi de filet à l'enchaînement automatique. Le SDK
  // peut finir un morceau sans émettre le moindre état — constaté en
  // production : l'affichage restait sur « 4:07 / 4:07, en lecture » sans fin
  // ni suite. Quand la position reste collée à la durée plusieurs secondes
  // alors que la lecture est censée continuer, le morceau est fini, quoi que
  // le SDK ait omis de dire.
  const pinnedTicksRef = useRef(0);

  useEffect(() => {
    if (paused || !duration) {
      pinnedTicksRef.current = 0;
      return;
    }

    const timer = setInterval(() => {
      setPosition((ms) => {
        const next = Math.min(ms + 1000, duration);

        if (next >= duration) {
          pinnedTicksRef.current += 1;
          if (
            pinnedTicksRef.current >= 3 &&
            Date.now() - lastAdvanceRef.current > 4000
          ) {
            pinnedTicksRef.current = 0;
            lastAdvanceRef.current = Date.now();
            // Hors du rendu : `setPosition` ne doit pas déclencher d'effets
            // de bord pendant que React calcule l'état.
            setTimeout(() => onNextRef.current(), 0);
          }
        } else {
          pinnedTicksRef.current = 0;
        }

        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [paused, duration]);

  /** Note et déclenche le retour visuel correspondant à l'avis exprimé. */
  const rateWithFeedback = useCallback(
    (trackId: string, value: number) => {
      setBurst({ value, key: Date.now() });
      void onRate(trackId, value);
    },
    [onRate],
  );

  // Raccourcis : 0-5 pour noter, N pour passer au suivant, espace pour la pause.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const track = currentRef.current;
      if (!track) return;

      const value = Number.parseInt(event.key, 10);
      if (Number.isInteger(value) && value >= 0 && value <= 5) {
        event.preventDefault();
        rateWithFeedback(track.trackId, value);
        return;
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        onNext();
      }
      if (event.key === " ") {
        event.preventDefault();
        void playerRef.current?.togglePlay();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rateWithFeedback, onNext]);

  const progress = duration ? Math.min(100, (position / duration) * 100) : 0;

  // Trois registres : on ne félicite pas un rejet comme un coup de cœur.
  const burstClass =
    burst === null
      ? ""
      : burst.value >= 4
        ? "animate-rating-love"
        : burst.value <= 1
          ? "animate-rating-reject"
          : "animate-rating-meh";

  const burstEmoji =
    burst === null ? "" : burst.value >= 4 ? "♥" : burst.value <= 1 ? "✕" : "•";

  return (
    <>
      <Script src={SDK_URL} strategy="afterInteractive" />

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface shadow-[0_-8px_24px_rgba(0,0,0,0.5)]">
        {/* Zone de clic généreuse : viser une barre de 2 pixels est pénible.
            Le rail visible reste fin, c'est la surface autour qui est cliquable. */}
        <button
          type="button"
          onClick={(event) => {
            if (!duration) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            const target = Math.max(0, Math.min(duration, ratio * duration));
            setPosition(target);
            void playerRef.current?.seek(target);
          }}
          disabled={!duration}
          aria-label="Seek within the track"
          className="group/seek relative block h-3 w-full cursor-pointer disabled:cursor-default"
        >
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-border" />
          <span
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 bg-accent transition-[width] duration-1000 ease-linear group-hover/seek:h-1.5"
            style={{ width: `${progress}%` }}
          />
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition group-hover/seek:opacity-100"
            style={{ left: `${progress}%` }}
          />
        </button>

        {/* Sur mobile, la ligne d'information et la rangée de notes se
            superposent au lieu de se disputer une largeur qu'elles n'ont pas :
            pochette + titre + transport d'abord, notation sur toute la largeur
            ensuite. */}
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
          {current ? (
            <>
              {current.cover ? (
                <Image
                  src={current.cover}
                  alt=""
                  width={64}
                  height={64}
                  className="h-12 w-12 shrink-0 rounded object-cover shadow-lg sm:h-16 sm:w-16"
                  unoptimized
                />
              ) : (
                <span className="h-12 w-12 shrink-0 rounded bg-surface-hover sm:h-16 sm:w-16" />
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium sm:text-base">
                  {current.name}
                </p>
                <p className="truncate text-xs text-muted sm:text-sm">
                  {current.artists}
                </p>
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted sm:text-xs">
                  {formatTime(position)} / {formatTime(duration)}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void playerRef.current?.togglePlay()}
                aria-label={paused ? "Resume" : "Pause"}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-background transition hover:bg-accent-strong sm:h-11 sm:w-11"
              >
                {paused ? "▶" : "❚❚"}
              </button>

              <button
                type="button"
                onClick={onNext}
                title="Next track (press N)"
                aria-label="Next track"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border transition hover:bg-surface-hover sm:h-11 sm:w-11"
              >
                ⏭
              </button>

              <div
                role="radiogroup"
                aria-label="Rate the current track"
                className="flex w-full items-center gap-1 sm:w-auto sm:shrink-0"
              >
                {RATING_LABELS.map((label, value) => {
                  const active = current.rating === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={`${value} — ${label}`}
                      title={`${value} — ${label} (press ${value})`}
                      onClick={() => rateWithFeedback(current.trackId, value)}
                      className={`relative h-10 flex-1 rounded-md text-sm font-medium transition sm:h-9 sm:w-9 sm:flex-none ${
                        active
                          ? value <= 1
                            ? "bg-negative text-background"
                            : "bg-accent text-background"
                          : "border border-border text-muted hover:text-foreground"
                      } ${burst?.value === value ? burstClass : ""}`}
                    >
                      {value}
                      {burst?.value === value && (
                        <span
                          key={burst.key}
                          aria-hidden
                          className={`animate-rating-float pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 text-base ${
                            value >= 4
                              ? "text-accent"
                              : value <= 1
                                ? "text-negative"
                                : "text-muted"
                          }`}
                        >
                          {burstEmoji}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              {error ??
                (ready
                  ? "Player ready — click a cover to start a track. Rate with 0-5, skip with N."
                  : "Connecting to the Spotify player…")}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

export { MIN_MEANINGFUL_MS };
