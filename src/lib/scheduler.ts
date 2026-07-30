import "server-only";

import { env } from "@/lib/env";

/**
 * Tâches périodiques, pour les hébergements qui font tourner un vrai serveur.
 *
 * Vercel déclenche les mêmes routes via `vercel.json`, ce que ne fait aucune
 * autre plateforme. Plutôt que de lier le projet à un hébergeur, un
 * planificateur interne appelle les mêmes routes HTTP, avec le même secret :
 * il n'existe qu'une seule implémentation de chaque tâche, et déployer
 * ailleurs — Railway, un conteneur, une machine — ne demande qu'une variable.
 *
 * Il reste donc désactivé par défaut : sur Vercel, l'activer ferait tourner
 * chaque tâche deux fois.
 */

/** Toutes les dix minutes : l'historique Spotify ne remonte que 50 écoutes. */
const POLL_EVERY_MS = 10 * 60_000;

/** Toutes les heures : l'enrichissement est borné en temps, pas en volume. */
const ENRICH_EVERY_MS = 60 * 60_000;

/** Heure locale de la sélection quotidienne. */
const DAILY_HOUR = 6;

/** Grain de la vérification quotidienne. */
const DAILY_CHECK_MS = 5 * 60_000;

function baseUrl(): string {
  // `NEXT_PUBLIC_SITE_URL` sert déjà de référence au retour OAuth ; on
  // s'adresse toutefois à la boucle locale, pour ne pas ressortir sur
  // l'internet et repasser par le proxy de l'hébergeur.
  const port = process.env.PORT ?? "3000";
  return `http://127.0.0.1:${port}`;
}

async function trigger(path: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${env().CRON_SECRET}` },
      cache: "no-store",
    });

    if (!response.ok) {
      console.warn(`[scheduler] ${path} a répondu ${response.status}`);
    }
  } catch (cause) {
    console.warn(
      `[scheduler] ${path} injoignable :`,
      cause instanceof Error ? cause.message : cause,
    );
  }
}

/** Jour civil, dans le fuseau d'écoute, pour ne générer qu'une fois par jour. */
const DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris",
  hour: "numeric",
  hour12: false,
});

export function startScheduler(): void {
  if (process.env.ENABLE_SCHEDULER !== "true") return;

  console.info("[scheduler] tâches périodiques activées");

  // Un premier passage tout de suite serait tentant, mais le serveur vient de
  // démarrer : on lui laisse le temps de répondre avant de s'appeler lui-même.
  setTimeout(() => void trigger("/api/cron/poll"), 30_000);

  setInterval(() => void trigger("/api/cron/poll"), POLL_EVERY_MS);
  setInterval(() => void trigger("/api/cron/enrich"), ENRICH_EVERY_MS);

  // La génération quotidienne se contente d'un rendez-vous approximatif : on
  // vérifie régulièrement si le jour a changé et si l'heure est passée. C'est
  // plus robuste qu'un minuteur calé sur minuit, qui manquerait son tour à
  // chaque redémarrage — et un redémarrage arrive à chaque déploiement.
  let lastRun: string | null = null;

  setInterval(() => {
    const now = new Date();
    const today = DAY_KEY.format(now);
    if (today === lastRun) return;
    if (Number(HOUR.format(now)) < DAILY_HOUR) return;

    lastRun = today;
    void trigger("/api/cron/generate");
  }, DAILY_CHECK_MS);
}
