import "server-only";

import { z } from "zod";

/**
 * Variables d'environnement serveur, validées au premier accès.
 *
 * On valide paresseusement plutôt qu'au chargement du module : `next build`
 * importe les modules serveur pour collecter les métadonnées des routes, et une
 * validation stricte à l'import ferait échouer un build lancé sans secrets
 * (typiquement en CI). L'erreur tombe alors à la première requête qui en a
 * réellement besoin, avec un message actionnable.
 */
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),

  // 32 octets encodés en base64 → 44 caractères avec padding.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message:
        'TOKEN_ENCRYPTION_KEY doit faire 32 octets en base64. Générer avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    }),

  CRON_SECRET: z.string().min(16),

  LASTFM_API_KEY: z.string().optional(),
  MUSICBRAINZ_USER_AGENT: z.string().min(1).default("NextTrack/0.1 ( unknown )"),

  NEXT_PUBLIC_SITE_URL: z.url().default("http://127.0.0.1:3000"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Variables d'environnement invalides ou manquantes :\n${details}\n\nVoir .env.example.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Identifiants Spotify, validés séparément.
 *
 * Ils sont volontairement hors du schéma principal : l'application doit démarrer
 * et rester consultable même sans application Spotify configurée. Sans cette
 * séparation, le proxy — qui s'exécute sur chaque requête — échouerait avant
 * même d'atteindre la page d'accueil, et l'utilisateur n'aurait aucun moyen de
 * comprendre ce qui manque.
 */
const spotifySchema = z.object({
  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),
});

export type SpotifyEnv = z.infer<typeof spotifySchema>;

let cachedSpotify: SpotifyEnv | null = null;

export function spotifyEnv(): SpotifyEnv {
  if (cachedSpotify) return cachedSpotify;

  const parsed = spotifySchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      "Application Spotify non configurée : renseignez SPOTIFY_CLIENT_ID et " +
        "SPOTIFY_CLIENT_SECRET dans .env.local, depuis " +
        "https://developer.spotify.com/dashboard",
    );
  }

  cachedSpotify = parsed.data;
  return cachedSpotify;
}

/** Permet à l'interface d'expliquer la situation plutôt que de planter. */
export function isSpotifyConfigured(): boolean {
  return spotifySchema.safeParse(process.env).success;
}

/**
 * Variables exposées au navigateur. Next.js remplace `process.env.NEXT_PUBLIC_*`
 * à la compilation : il faut donc les écrire littéralement, sans indexation
 * dynamique, sinon la substitution n'a pas lieu.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://127.0.0.1:3000",
};
