import type { Depeche } from "@/lib/news/fetch";

import { Horodatage } from "./horodatage";
import { ImageArticle } from "./image-article";

export type RubriqueCarte = {
  label: string;
  folio: string;
};

/** Surligne de presse : SOURCE · HORODATAGE, en mono capitales. */
export function Surligne({ dep }: { dep: Depeche }) {
  return (
    <p className="font-telex text-[11px] uppercase tracking-[0.08em] text-encre-2 [font-variant-numeric:tabular-nums]">
      {dep.source}
      {dep.date && (
        <>
          {" · "}
          <Horodatage iso={dep.date} />
        </>
      )}
    </p>
  );
}

/** Le titre est le lien : il ouvre l'article chez son éditeur (↗). */
export function LienArticle({ dep }: { dep: Depeche }) {
  return (
    <a
      href={dep.lien}
      target="_blank"
      rel="noopener noreferrer"
      data-article-link
      className="decoration-encre decoration-[3px] underline-offset-[6px] hover:underline focus-visible:underline"
    >
      {dep.titre}
      <span
        aria-hidden
        className="ml-2 inline-block font-telex text-[0.55em] align-[0.5em] text-encre-2"
      >
        ↗
      </span>
    </a>
  );
}

/** Filigrane : initiale de la rubrique en creux géant, quand l'image manque. */
function Filigrane({ rubrique }: { rubrique: RubriqueCarte }) {
  return (
    <span
      aria-hidden
      className="creux-filigrane pointer-events-none absolute -top-8 right-0 select-none font-titrage text-[10rem] uppercase leading-none lg:text-[13rem]"
    >
      {rubrique.label.charAt(0)}
    </span>
  );
}

/**
 * Rangée A — la manchette : un seul article, composé comme une affiche.
 * Titre en corps géant, extrait sur deux colonnes, image en bandeau 21:9.
 */
export function CarteManchette({
  dep,
  rubrique,
}: {
  dep: Depeche;
  rubrique: RubriqueCarte;
}) {
  return (
    <article className="carte group relative overflow-hidden py-8">
      {!dep.image && <Filigrane rubrique={rubrique} />}
      <Surligne dep={dep} />
      <h2 className="mt-3 max-w-[24ch] font-titrage uppercase leading-[0.95] [text-wrap:balance] text-[clamp(1.9rem,4.2vw,4.4rem)]">
        <LienArticle dep={dep} />
      </h2>
      {dep.extrait && (
        <p className="mt-4 max-w-[75ch] font-texte text-[15px] leading-[1.55] text-encre-2 lg:columns-2 lg:gap-10">
          {dep.extrait}
        </p>
      )}
      {dep.image && (
        <div className="mt-6 aspect-[21/9] w-full overflow-hidden">
          <ImageArticle src={dep.image} alt="" folio={rubrique.folio} />
        </div>
      )}
    </article>
  );
}

/**
 * Carte courante (rangées B « tierce ») : vignette, surligne, titre en
 * Archivo gras, extrait limité à deux lignes.
 */
export function CarteCourante({
  dep,
  rubrique,
}: {
  dep: Depeche;
  rubrique: RubriqueCarte;
}) {
  return (
    <article className="carte group relative overflow-hidden py-6">
      {dep.image ? (
        <div className="mb-4 aspect-[3/2] w-full overflow-hidden">
          <ImageArticle src={dep.image} alt="" folio={rubrique.folio} />
        </div>
      ) : (
        <Filigrane rubrique={rubrique} />
      )}
      <Surligne dep={dep} />
      <h3 className="mt-2 font-titre text-[21px] font-extrabold leading-snug">
        <LienArticle dep={dep} />
      </h3>
      {dep.extrait && (
        <p className="mt-2 font-texte text-[14px] leading-[1.55] text-encre-2 line-clamp-2">
          {dep.extrait}
        </p>
      )}
    </article>
  );
}

/**
 * Rangée C — la grille cassée 7/5 : à gauche l'image et un titre Anton qui
 * déborde volontairement de 32px sur le filet voisin ; à droite une carte
 * toute en texte derrière le filet vertical.
 */
export function RangeeCassee({
  deps,
  rubrique,
}: {
  deps: Depeche[];
  rubrique: RubriqueCarte;
}) {
  const [gauche, droite] = deps;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-0">
      <article className="carte group relative py-6 lg:col-span-7 lg:pr-6">
        {gauche.image && (
          <div className="mb-4 aspect-video w-full overflow-hidden">
            <ImageArticle src={gauche.image} alt="" folio={rubrique.folio} />
          </div>
        )}
        <Surligne dep={gauche} />
        <h3 className="relative z-10 mt-2 font-titrage text-[clamp(1.5rem,2.4vw,2.4rem)] uppercase leading-[0.98] lg:-mr-8">
          <LienArticle dep={gauche} />
        </h3>
      </article>
      {droite && (
        <article className="carte group relative overflow-hidden border-t border-encre py-6 lg:col-span-5 lg:border-t-0 lg:border-l lg:pl-6">
          {!droite.image && <Filigrane rubrique={rubrique} />}
          <Surligne dep={droite} />
          <h3 className="mt-2 font-titre text-[22px] font-extrabold leading-snug">
            <LienArticle dep={droite} />
          </h3>
          {droite.extrait && (
            <p className="mt-3 font-texte text-[14px] leading-[1.55] text-encre-2 line-clamp-3">
              {droite.extrait}
            </p>
          )}
        </article>
      )}
    </div>
  );
}
