/**
 * Limiteur de débit sériel, partagé par hôte distant.
 *
 * Chaque appelant s'enfile derrière le précédent, ce qui garantit un intervalle
 * minimal entre deux requêtes sortantes. C'est ce que réclament MusicBrainz
 * (1 req/s, règle explicite) et, plus prudemment, Spotify — dont le quota est
 * décompté par compte développeur : un dépassement provoqué par un utilisateur
 * pénalise tous les autres.
 *
 * La portée est celle du processus. Sur Vercel, plusieurs instances de fonction
 * peuvent tourner en parallèle et chacune aura sa propre file. C'est acceptable
 * parce que les gros volumes (l'enrichissement du catalogue) passent par un
 * unique job séquentiel, et parce que la pause consécutive à un 429 est, elle,
 * persistée en base et donc respectée par toutes les instances.
 */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private pausedUntil = 0;

  constructor(
    private readonly minIntervalMs: number,
    readonly name: string,
  ) {}

  /** Attend son tour. À `await` juste avant l'appel réseau. */
  async acquire(): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    const waitMs = Math.max(
      this.minIntervalMs,
      this.pausedUntil - Date.now(),
    );
    if (waitMs > 0) await sleep(waitMs);

    // On libère le suivant après l'attente : la file avance d'un cran par
    // intervalle, sans jamais laisser passer deux requêtes coup sur coup.
    setTimeout(release, 0);
  }

  /** Suspend toutes les requêtes suivantes (réponse à un 429). */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  get isPaused(): boolean {
    return this.pausedUntil > Date.now();
  }

  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Limiteurs par service.
 *
 * - Spotify : pas de limite publiée. Spotify calcule le quota sur une fenêtre
 *   glissante d'environ 30 secondes ; 120 ms entre deux appels (~8/s) laisse une
 *   marge confortable tout en gardant l'enrichissement praticable.
 * - MusicBrainz : 1 req/s, règle explicite et appliquée, avec User-Agent obligatoire.
 * - Last.fm et ListenBrainz : pas de limite stricte documentée, on reste courtois.
 * - ReccoBeats : non documenté, on reste prudent.
 */
export const limiters = {
  // 400 ms et non 120 : le quota du mode développement se juge sur une fenêtre
  // glissante de trente secondes, et ce sont les rafales qui déclenchent les
  // 429 — dont les pénalités, constatées, se comptent en heures.
  spotify: new RateLimiter(400, "spotify"),
  musicbrainz: new RateLimiter(1100, "musicbrainz"),
  lastfm: new RateLimiter(220, "lastfm"),
  listenbrainz: new RateLimiter(250, "listenbrainz"),
  reccobeats: new RateLimiter(150, "reccobeats"),
};
