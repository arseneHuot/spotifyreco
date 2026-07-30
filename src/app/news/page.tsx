import Link from "next/link";

import {
  CarteManchette,
  LienArticle,
  Surligne,
} from "@/components/news/carte";
import { ImageArticle } from "@/components/news/image-article";
import { LectureTracker } from "@/components/news/lecture-tracker";
import { Pulse } from "@/components/news/pulse";
import { VT } from "@/components/news/vt";
import { getReleve, type Depeche } from "@/lib/news/fetch";
import { CATEGORIES } from "@/lib/news/feeds";

export const revalidate = 300;

const fmtHeure = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

/**
 * Colonnes de la mosaïque : motif de grille cassée 5/7 · 4/4/4 · 6/6 · 12.
 * Classes littérales — Tailwind ne compile pas les classes construites.
 */
const SPANS = [
  "lg:col-span-5",
  "lg:col-span-7",
  "lg:col-span-4",
  "lg:col-span-4",
  "lg:col-span-4",
  "lg:col-span-6",
  "lg:col-span-6",
  "lg:col-span-12",
];

function BlocRubrique({
  slug,
  label,
  dep,
  span,
  folio,
}: {
  slug: string;
  label: string;
  dep: Depeche;
  span: string;
  folio: string;
}) {
  return (
    <article
      className={`carte group relative overflow-hidden border-t border-encre pt-3 ${span}`}
    >
      <Link
        href={`/news/${slug}`}
        className="font-titrage text-[1.6rem] uppercase leading-none"
      >
        <span className="creux">{label}</span>
        <span aria-hidden className="ml-2 font-telex text-[11px] text-encre-2">
          {folio}
        </span>
      </Link>
      {dep.image && (
        <div className="mt-3 aspect-[3/2] w-full overflow-hidden">
          <ImageArticle src={dep.image} alt="" folio={folio} />
        </div>
      )}
      <h3 className="mt-3 font-titre text-[22px] font-extrabold leading-snug">
        <LienArticle dep={dep} />
      </h3>
      <div className="mt-2">
        <Surligne dep={dep} />
      </div>
      {!dep.image && dep.extrait && (
        <p className="mt-3 font-texte text-[14px] leading-[1.55] text-encre-2 line-clamp-3">
          {dep.extrait}
        </p>
      )}
    </article>
  );
}

/**
 * La Une : une affiche composée — la dépêche la plus récente en manchette
 * géante, puis la tête de chaque rubrique en mosaïque cassée.
 */
export default async function PageUne() {
  const releves = await Promise.all(
    CATEGORIES.map((c) => getReleve(c.slug)),
  );
  const une = releves[0];
  const hero = une?.depeches[0];
  const suivantes = une?.depeches.slice(1, 4) ?? [];

  const tetes = CATEGORIES.slice(1)
    .map((cat, i) => ({
      cat,
      folio: String(i + 2).padStart(2, "0"),
      dep: releves[i + 1]?.depeches[0],
    }))
    .filter((t): t is typeof t & { dep: Depeche } => Boolean(t.dep));

  return (
    <VT name="riviere">
      <div className="pb-16">
        <LectureTracker />
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b-[3px] border-encre pb-4 pt-8">
          <h1 className="font-titrage text-[clamp(2.6rem,6vw,5.5rem)] uppercase leading-[0.9]">
            La Une
          </h1>
          {une && (
            <p className="font-telex text-[11px] uppercase tracking-[0.14em] text-encre-2 [font-variant-numeric:tabular-nums]">
              {CATEGORIES.length} rubriques · relevé de{" "}
              {fmtHeure.format(new Date(une.releveA))}
            </p>
          )}
        </header>

        <Pulse
          key={une?.releveA}
          rubrique="une"
          liens={une?.depeches.slice(0, 12).map((d) => d.lien) ?? []}
        />

        {hero && (
          <CarteManchette dep={hero} rubrique={{ label: "Une", folio: "01" }} />
        )}

        {suivantes.length > 0 && (
          <div className="grid grid-cols-1 border-t border-filet-faible lg:grid-cols-3 lg:divide-x lg:divide-filet-faible">
            {suivantes.map((dep) => (
              <article key={dep.lien} className="carte group py-5 lg:px-6 first:lg:pl-0 last:lg:pr-0">
                <Surligne dep={dep} />
                <h3 className="mt-2 font-titre text-[19px] font-extrabold leading-snug">
                  <LienArticle dep={dep} />
                </h3>
              </article>
            ))}
          </div>
        )}

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {tetes.map((t, i) => (
            <BlocRubrique
              key={t.cat.slug}
              slug={t.cat.slug}
              label={t.cat.label}
              dep={t.dep}
              folio={t.folio}
              span={SPANS[i % SPANS.length]}
            />
          ))}
        </div>
      </div>
    </VT>
  );
}
