/**
 * Formatage des dates affichées.
 *
 * Le fuseau est explicite pour deux raisons. Vercel tourne en UTC : sans lui,
 * une date rendue côté serveur puis côté client diverge après 22 h UTC, ce que
 * React signale en erreur d'hydratation. Et c'est le fuseau de l'écoute, pas
 * celui du serveur, qui découpe les journées — la génération quotidienne s'y
 * cale aussi.
 */
export const DISPLAY_TIME_ZONE = "Europe/Paris";

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: DISPLAY_TIME_ZONE,
});

const FULL_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: DISPLAY_TIME_ZONE,
});

/** « 28 Jul » — pour les listes, où l'année encombre plus qu'elle n'informe. */
export function formatDayMonth(value: string | Date): string {
  return DAY_MONTH.format(typeof value === "string" ? new Date(value) : value);
}

/** « 28 Jul 2026 » — dès que la date peut être lointaine. */
export function formatDate(value: string | Date): string {
  return FULL_DATE.format(typeof value === "string" ? new Date(value) : value);
}
