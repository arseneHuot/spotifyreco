/**
 * Registre des flux agrégés, organisé par catégorie.
 *
 * Chaque URL a été vérifiée le 28/07/2026 (réponse 200, items présents,
 * encodage UTF-8). Quelques pièges connus, gérés par le parseur :
 * - Libération ne publie aucune image dans son flux ;
 * - La Tribune met l'URL d'image en texte dans <enclosure> et ses dates en
 *   ISO 8601 ;
 * - Futura enveloppe ses pubDate dans du CDATA ;
 * - Capital n'est pas servi sur capital.fr mais chez Prisma Media ;
 * - l'ancien flux lequipe.fr/rss/actu_rss.xml est mort (404), le remplaçant
 *   officiel vit sur dwh.lequipe.fr.
 */

export type FeedSource = {
  /** Nom affiché de la rédaction. */
  name: string;
  url: string;
};

export type Category = {
  slug: string;
  /** Nom affiché, en capitales dans la navigation. */
  label: string;
  sources: FeedSource[];
};

export const CATEGORIES: Category[] = [
  {
    slug: "une",
    label: "Une",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/rss/une.xml" },
      { name: "France Info", url: "https://www.francetvinfo.fr/titres.rss" },
      {
        name: "Libération",
        url: "https://www.liberation.fr/arc/outboundfeeds/rss-all/?outputType=xml",
      },
      {
        name: "Le Figaro",
        url: "https://www.lefigaro.fr/rss/figaro_actualites.xml",
      },
      { name: "20 Minutes", url: "https://www.20minutes.fr/feeds/rss-une.xml" },
    ],
  },
  {
    slug: "monde",
    label: "Monde",
    sources: [
      {
        name: "Le Monde",
        url: "https://www.lemonde.fr/international/rss_full.xml",
      },
      { name: "France Info", url: "https://www.francetvinfo.fr/monde.rss" },
      {
        name: "Courrier International",
        url: "https://www.courrierinternational.com/feed/all/rss.xml",
      },
      { name: "France 24", url: "https://www.france24.com/fr/rss" },
      {
        name: "Le Figaro",
        url: "https://www.lefigaro.fr/rss/figaro_international.xml",
      },
    ],
  },
  {
    slug: "france",
    label: "France",
    sources: [
      { name: "France Info", url: "https://www.francetvinfo.fr/france.rss" },
      { name: "Le Monde", url: "https://www.lemonde.fr/societe/rss_full.xml" },
      {
        name: "20 Minutes",
        url: "https://www.20minutes.fr/feeds/rss-societe.xml",
      },
    ],
  },
  {
    slug: "politique",
    label: "Politique",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/politique/rss_full.xml" },
      { name: "France Info", url: "https://www.francetvinfo.fr/politique.rss" },
      {
        name: "Le Figaro",
        url: "https://www.lefigaro.fr/rss/figaro_politique.xml",
      },
    ],
  },
  {
    slug: "economie",
    label: "Économie",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/economie/rss_full.xml" },
      { name: "France Info", url: "https://www.francetvinfo.fr/economie.rss" },
      {
        name: "Le Figaro",
        url: "https://www.lefigaro.fr/rss/figaro_economie.xml",
      },
      { name: "La Tribune", url: "https://www.latribune.fr/rss/homepage" },
      {
        name: "Capital",
        url: "https://feed.prismamediadigital.com/v1/cap/rss",
      },
    ],
  },
  {
    slug: "tech",
    label: "Tech",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/pixels/rss_full.xml" },
      { name: "Numerama", url: "https://www.numerama.com/feed/" },
      { name: "Journal du Geek", url: "https://www.journaldugeek.com/feed/" },
      { name: "Next", url: "https://next.ink/feed/" },
      { name: "France Info", url: "https://www.francetvinfo.fr/internet.rss" },
    ],
  },
  {
    slug: "sciences",
    label: "Sciences",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/sciences/rss_full.xml" },
      {
        name: "Futura",
        url: "https://www.futura-sciences.com/rss/actualites.xml",
      },
      {
        name: "Sciences et Avenir",
        url: "https://www.sciencesetavenir.fr/rss.xml",
      },
      { name: "France Info", url: "https://www.francetvinfo.fr/sciences.rss" },
      { name: "Le Monde Planète", url: "https://www.lemonde.fr/planete/rss_full.xml" },
    ],
  },
  {
    slug: "sport",
    label: "Sport",
    sources: [
      {
        name: "L'Équipe",
        url: "https://dwh.lequipe.fr/api/edito/rss?path=/Tous%20sports",
      },
      { name: "France Info", url: "https://www.francetvinfo.fr/sports.rss" },
      { name: "Le Monde", url: "https://www.lemonde.fr/sport/rss_full.xml" },
      {
        name: "Sport24",
        url: "https://sport24.lefigaro.fr/rssfeeds/sport24-accueil.xml",
      },
    ],
  },
  {
    slug: "culture",
    label: "Culture",
    sources: [
      { name: "Le Monde", url: "https://www.lemonde.fr/culture/rss_full.xml" },
      { name: "France Info", url: "https://www.francetvinfo.fr/culture.rss" },
      {
        name: "Le Figaro",
        url: "https://www.lefigaro.fr/rss/figaro_culture.xml",
      },
      { name: "Les Inrocks", url: "https://www.lesinrocks.com/feed/" },
      { name: "Konbini", url: "https://www.konbini.com/feed/" },
    ],
  },
];

/**
 * Destinations de redirection admises en plus des hôtes du registre.
 *
 * Deux flux redirigent vers un autre domaine (rebranding de France Info,
 * absorption de Sport24 par lefigaro.fr). Sans cette liste, la vérification
 * anti-SSRF de `fetch.ts` les traiterait comme des détournements et huit
 * rubriques perdraient France Info.
 */
export const HOTES_REDIRECTION = ["www.franceinfo.fr", "www.lefigaro.fr"];

export function getCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}
