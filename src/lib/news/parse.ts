/**
 * Parseur RSS 2.0 / Atom minimaliste.
 *
 * Le projet n'embarque aucune bibliothèque XML et les flux de presse sont
 * suffisamment réguliers pour s'en passer : on extrait les champs utiles par
 * expressions régulières plutôt que d'ajouter une dépendance pour ça. Le
 * parseur doit en revanche tolérer les variantes réelles rencontrées dans les
 * flux français : CDATA, entités HTML, images en `media:content`, `enclosure`
 * ou `<img>` dans la description, dates RFC 822 comme ISO 8601.
 */

export type ParsedItem = {
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
  image: string | null;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  ucirc: "û",
  ugrave: "ù",
  icirc: "î",
  iuml: "ï",
  euml: "ë",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
};

/**
 * `String.fromCodePoint` lève au-delà de U+10FFFF ou sur un demi-substitut.
 * Un `&#x110000;` dans un seul titre ferait alors échouer tout le flux, donc
 * toute la rédaction : on laisse l'entité invalide telle quelle.
 */
function versCaractere(valeur: number, brut: string): string {
  if (!Number.isFinite(valeur) || valeur < 0 || valeur > 0x10ffff) return brut;
  if (valeur >= 0xd800 && valeur <= 0xdfff) return brut;
  return String.fromCodePoint(valeur);
}

/**
 * Les entités nommées portent une casse signifiante : `&Eacute;` est un É
 * majuscule. Une simple mise en minuscules de la clé transformerait
 * « &Eacute;cole » en « école ».
 */
function entiteNommee(nom: string): string | null {
  const exact = NAMED_ENTITIES[nom];
  if (exact) return exact;
  const minuscule = NAMED_ENTITIES[nom.toLowerCase()];
  if (!minuscule) return null;
  return /^[A-Z]/.test(nom) ? minuscule.toUpperCase() : minuscule;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gi, (m, hex: string) =>
      versCaractere(parseInt(hex, 16), m),
    )
    .replace(/&#(\d+);/g, (m, dec: string) =>
      versCaractere(parseInt(dec, 10), m),
    )
    .replace(/&([a-zA-Z]+);/g, (m, nom: string) => entiteNommee(nom) ?? m);
}

/**
 * Ne retire que ce qui ressemble vraiment à une balise : un chevron suivi
 * d'une lettre ou d'une barre oblique. Un « <2 % » ou un « >3 % » d'article
 * économique n'en est pas une, et le motif naïf `<[^>]*>` avalait la phrase
 * entière entre les deux.
 */
const BALISE_HTML = /<\/?[a-zA-Z][^>]*>/g;

/** Retire CDATA, balises HTML et blancs superflus pour obtenir du texte brut. */
function toPlainText(raw: string): string {
  const sansCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Les balises réelles d'abord, puis le décodage — qui peut à son tour
  // révéler du HTML échappé (`&lt;p&gt;`), d'où la seconde passe.
  const sansBalises = sansCdata.replace(BALISE_HTML, " ");
  const decode = decodeEntities(sansBalises);
  return decodeEntities(decode.replace(BALISE_HTML, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Contenu brut de la première occurrence de `tag` (namespaces tolérés). */
function tagContent(xml: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`,
    "i",
  );
  return re.exec(xml)?.[1] ?? null;
}

function attrOfTag(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\s[^>]*?${attr}\\s*=\\s*["']([^"']+)["']`, "i");
  return re.exec(xml)?.[1] ?? null;
}

/**
 * N'accepte que les URL http(s), rendues telles quelles dans un `src` : un
 * flux compromis ne doit pas pouvoir y glisser autre chose. Les adresses
 * relatives au protocole (`//cdn/x.jpg`), courantes dans les flux, sont
 * ramenées en https plutôt que rejetées.
 */
function urlSure(url: string | null | undefined): string | null {
  if (!url) return null;
  const nettoyee = decodeEntities(url).trim();
  if (nettoyee.startsWith("//")) return `https:${nettoyee}`;
  return /^https?:\/\//i.test(nettoyee) ? nettoyee : null;
}

/** Un `media:content` peut décrire une vidéo ou un son : pas une vignette. */
function estVisuel(tag: string): boolean {
  const type = /type\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  const medium = /medium\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  if (type && !type.toLowerCase().startsWith("image/")) return false;
  if (medium && medium.toLowerCase() !== "image") return false;
  return true;
}

/**
 * Première URL d'image plausible d'un item, dans l'ordre de fiabilité observé
 * sur les flux de presse : `media:content`, `media:thumbnail`, `enclosure`
 * d'un type image, puis `<img>` embarquée dans la description. Chaque
 * stratégie passe la main à la suivante si elle ne donne rien d'exploitable.
 */
function extractImage(itemXml: string): string | null {
  for (const tag of ["media:content", "media:thumbnail"]) {
    const re = new RegExp(`<${tag}\\s[^>]*>`, "gi");
    for (const m of itemXml.matchAll(re)) {
      if (!estVisuel(m[0])) continue;
      const url = urlSure(/url\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]);
      if (url) return url;
    }
  }

  for (const m of itemXml.matchAll(/<enclosure(?:\s[^>]*)?>/gi)) {
    if (!estVisuel(m[0])) continue;
    const url = urlSure(/url\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]);
    if (url) return url;
  }

  // La Tribune met l'URL de l'image en texte dans <enclosure>, sans attribut.
  const enclosureText =
    /<enclosure(?:\s[^>]*)?>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<\]]+)/i.exec(
      itemXml,
    );
  const parTexte = urlSure(enclosureText?.[1]);
  if (parTexte) return parTexte;

  for (const m of decodeEntities(itemXml).matchAll(
    /<img\s[^>]*?src\s*=\s*["']([^"']+)["']/gi,
  )) {
    const url = urlSure(m[1]);
    if (url) return url;
  }

  return null;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const date = new Date(toPlainText(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Lien d'un item RSS (texte) ou d'une entrée Atom (attribut `href`). */
function extractLink(itemXml: string): string {
  const rssLink = tagContent(itemXml, "link");
  if (rssLink && toPlainText(rssLink)) return toPlainText(rssLink);

  const alternate =
    /<link\s[^>]*?rel\s*=\s*["']alternate["'][^>]*?href\s*=\s*["']([^"']+)["']/i.exec(
      itemXml,
    )?.[1] ?? attrOfTag(itemXml, "link", "href");
  return alternate ? decodeEntities(alternate) : "";
}

function parseItem(itemXml: string): ParsedItem | null {
  const title = toPlainText(tagContent(itemXml, "title") ?? "");
  const link = extractLink(itemXml);
  // Les liens sont rendus tels quels dans des <a href> : un flux compromis ne
  // doit pas pouvoir y glisser un `javascript:`.
  if (!title || !/^https?:\/\//i.test(link)) return null;

  const rawDescription =
    tagContent(itemXml, "description") ??
    tagContent(itemXml, "summary") ??
    tagContent(itemXml, "content:encoded") ??
    tagContent(itemXml, "content") ??
    "";

  const description = toPlainText(rawDescription).slice(0, 400);
  const publishedAt = parseDate(
    tagContent(itemXml, "pubDate") ??
      tagContent(itemXml, "dc:date") ??
      tagContent(itemXml, "published") ??
      tagContent(itemXml, "updated"),
  );

  return { title, link, description, publishedAt, image: extractImage(itemXml) };
}

/** Au-delà, ce n'est plus un flux de presse : on arrête de découper. */
const MAX_ITEMS = 400;

/**
 * Découpe les blocs `<tag>…</tag>` par recherche d'index plutôt qu'avec une
 * regex globale à quantificateur paresseux : sur un document où les balises
 * ne sont jamais refermées, cette dernière rebalaie tout le reste du texte à
 * chaque ouverture (mesuré : 3 s de CPU bloquant pour 1 Mo). Ici le curseur
 * n'avance que vers l'avant, donc le coût reste linéaire.
 */
function decoupeBlocs(xml: string, tag: string): string[] {
  const ouverture = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  const fermeture = `</${tag}`;
  const blocs: string[] = [];
  let curseur = 0;

  while (blocs.length < MAX_ITEMS) {
    ouverture.lastIndex = curseur;
    const debut = ouverture.exec(xml);
    if (!debut) break;

    const apresOuverture = debut.index + debut[0].length;
    const fin = xml.indexOf(fermeture, apresOuverture);
    if (fin === -1) break;

    blocs.push(xml.slice(apresOuverture, fin));
    curseur = fin + fermeture.length;
  }
  return blocs;
}

export function parseFeed(xml: string): ParsedItem[] {
  const blocs = [...decoupeBlocs(xml, "item"), ...decoupeBlocs(xml, "entry")];
  return blocs
    .map((bloc) => parseItem(bloc))
    .filter((item): item is ParsedItem => item !== null);
}

/**
 * Décode la réponse HTTP d'un flux en respectant son charset : quelques flux
 * français sont encore servis en ISO-8859-1, un `text()` naïf produirait des
 * caractères accentués corrompus.
 */
export function decodeXmlBuffer(buffer: ArrayBuffer, contentType: string | null): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const declared =
    /charset=([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /encoding=["']([\w-]+)["']/i.exec(utf8.slice(0, 200))?.[1];
  const charset = declared?.toLowerCase() ?? "utf-8";
  if (charset === "utf-8" || charset === "utf8") return utf8;
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return utf8;
  }
}
