import "server-only";

import { cache } from "react";

import {
  CATEGORIES,
  type Category,
  getCategory,
  HOTES_REDIRECTION,
} from "./feeds";
import { decodeXmlBuffer, parseFeed } from "./parse";

export type Depeche = {
  titre: string;
  lien: string;
  extrait: string;
  /** ISO 8601, null si le flux n'a pas fourni de date exploitable. */
  date: string | null;
  image: string | null;
  source: string;
};

export type EtatSource = {
  name: string;
  ok: boolean;
  count: number;
};

export type Releve = {
  depeches: Depeche[];
  sources: EtatSource[];
  releveA: string;
};

/**
 * Certaines rédactions servent une page vide aux clients sans User-Agent de
 * navigateur ; toutes acceptent celui-ci (vérifié flux par flux).
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Cache serveur des flux : les pages se régénèrent toutes les 5 minutes. */
const REVALIDATE_S = 300;

/** Budget total par flux, en-têtes ET corps compris. */
const TIMEOUT_MS = 6000;

/**
 * Plafond de lecture. Le plus gros flux de la liste pèse ~350 Ko ; 8 Mo laisse
 * une marge énorme tout en bornant ce qu'un hôte détourné peut faire allouer
 * (`fetch` décompresse gzip, la taille sur le fil n'est donc pas une borne).
 */
const MAX_OCTETS = 8 * 1024 * 1024;

/** Hôtes autorisés, dérivés du registre : la seule barrière anti-SSRF. */
const HOTES_CONNUS = new Set([
  ...CATEGORIES.flatMap((c) => c.sources.map((s) => new URL(s.url).hostname)),
  ...HOTES_REDIRECTION,
]);

/**
 * Lit le corps par morceaux en s'arrêtant au plafond. `arrayBuffer()`
 * bufferiserait sans limite : un flux compromis pourrait rendre des centaines
 * de mégaoctets et faire tomber l'instance.
 */
async function litCorpsBorne(res: Response): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();

  const morceaux: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OCTETS) {
        throw new Error(`corps au-delà de ${MAX_OCTETS} octets`);
      }
      morceaux.push(value);
    }
  } finally {
    // Referme la socket, que l'on soit sorti par la fin du flux ou par erreur.
    await reader.cancel().catch(() => {});
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const m of morceaux) {
    buffer.set(m, offset);
    offset += m.byteLength;
  }
  return buffer.buffer;
}

/**
 * Le timeout enveloppe la lecture complète, pas seulement les en-têtes : une
 * source qui répond 200 puis n'émet qu'un octet par minute bloquerait sinon le
 * rendu de toute la section jusqu'au plafond de la plateforme.
 *
 * Pas d'AbortSignal : il désactiverait la mémoïsation de `fetch` (doc locale
 * `fetch.md`). La requête perdante est abandonnée et son corps annulé par
 * `litCorpsBorne`.
 */
function avecTimeout<T>(promesse: Promise<T>, ms: number): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout>;
  return Promise.race([
    promesse,
    new Promise<never>((_, reject) => {
      minuteur = setTimeout(
        () => reject(new Error(`délai de ${ms} ms dépassé`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(minuteur)) as Promise<T>;
}

async function litFlux(url: string): Promise<Omit<Depeche, "source">[]> {
  const xml = await avecTimeout(
    (async () => {
      const res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
        next: { revalidate: REVALIDATE_S, tags: ["news"] },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Les redirections sont suivies par défaut : sans ce contrôle, un flux
      // détourné pourrait faire lire une adresse interne au déploiement et en
      // publier le contenu sur une page publique.
      const hoteFinal = new URL(res.url || url).hostname;
      if (!HOTES_CONNUS.has(hoteFinal)) {
        throw new Error(`redirection vers un hôte inconnu : ${hoteFinal}`);
      }

      return decodeXmlBuffer(
        await litCorpsBorne(res),
        res.headers.get("content-type"),
      );
    })(),
    TIMEOUT_MS,
  );

  return parseFeed(xml).map((item) => ({
    titre: item.title,
    lien: item.link,
    extrait: item.description,
    date: item.publishedAt,
    image: item.image,
  }));
}

/**
 * Relève tous les flux d'une catégorie. Un flux muet ou trop lent est
 * simplement signalé dans `sources` — il ne bloque jamais le rendu.
 */
async function releveCategorie(categorie: Category): Promise<Releve> {
  const resultats = await Promise.allSettled(
    categorie.sources.map(async (source) => ({
      source,
      items: await litFlux(source.url),
    })),
  );

  const sources: EtatSource[] = [];
  const parLien = new Map<string, Depeche>();
  const titresVus = new Set<string>();

  for (const [i, resultat] of resultats.entries()) {
    const nom = categorie.sources[i].name;
    if (resultat.status === "rejected") {
      sources.push({ name: nom, ok: false, count: 0 });
      continue;
    }
    sources.push({ name: nom, ok: true, count: resultat.value.items.length });
    for (const item of resultat.value.items) {
      // Une même dépêche revient parfois par deux flux (Le Monde Une +
      // rubrique) : on déduplique par lien puis par titre normalisé.
      const titreCle = item.titre.toLowerCase().replace(/\s+/g, " ");
      if (parLien.has(item.lien) || titresVus.has(titreCle)) continue;
      titresVus.add(titreCle);
      parLien.set(item.lien, { ...item, source: nom });
    }
  }

  const depeches = [...parLien.values()]
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date < a.date ? -1 : 1;
    })
    .slice(0, 48);

  return { depeches, sources, releveA: new Date().toISOString() };
}

/**
 * `cache()` (React) déduplique par rendu au niveau de la catégorie entière :
 * le cordon, la page et les métadonnées partagent la même relève.
 */
export const getReleve = cache(async (slug: string): Promise<Releve | null> => {
  const categorie = getCategory(slug);
  if (!categorie) return null;
  return releveCategorie(categorie);
});
