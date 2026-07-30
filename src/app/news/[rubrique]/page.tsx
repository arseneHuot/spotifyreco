import { notFound, redirect } from "next/navigation";

import { LectureTracker } from "@/components/news/lecture-tracker";
import { Pulse } from "@/components/news/pulse";
import { Riviere } from "@/components/news/riviere";
import { VT } from "@/components/news/vt";
import { CATEGORIES, getCategory } from "@/lib/news/feeds";
import { getReleve } from "@/lib/news/fetch";

export const revalidate = 300;

const fmtHeure = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

export function generateStaticParams() {
  return CATEGORIES.filter((c) => c.slug !== "une").map((c) => ({
    rubrique: c.slug,
  }));
}

export async function generateMetadata({
  params,
}: PageProps<"/news/[rubrique]">) {
  const { rubrique } = await params;
  const cat = getCategory(rubrique);
  if (!cat) return { title: "Rubrique introuvable" };
  return {
    title: cat.label,
    description: `Les dépêches ${cat.label} de ${cat.sources
      .map((s) => s.name)
      .join(", ")}, relevées toutes les cinq minutes.`,
  };
}

export default async function PageRubrique({
  params,
}: PageProps<"/news/[rubrique]">) {
  const { rubrique } = await params;
  // La Une vit à /news : une seule adresse par rubrique.
  if (rubrique === "une") redirect("/news");

  const cat = getCategory(rubrique);
  if (!cat) notFound();

  const releve = await getReleve(rubrique);
  const index = CATEGORIES.findIndex((c) => c.slug === rubrique);
  const folio = String(index + 1).padStart(2, "0");
  const muets = releve?.sources.filter((s) => !s.ok) ?? [];

  return (
    <VT name="riviere">
      <div className="relative pb-16">
        <LectureTracker />
        {/* Le dos du journal : rappel de la rubrique le long de la tranche. */}
        <span
          aria-hidden
          className="creux-filigrane pointer-events-none fixed right-2 top-1/2 z-30 hidden -translate-y-1/2 select-none font-titrage text-5xl uppercase [writing-mode:vertical-rl] xl:block"
        >
          {cat.label}
        </span>

        <header className="border-b-[3px] border-encre pb-4 pt-8">
          <p className="font-telex text-[11px] uppercase tracking-[0.14em] text-encre-2 [font-variant-numeric:tabular-nums]">
            Rubrique {folio} · {releve?.depeches.length ?? 0} dépêches
            {releve && ` · relevé de ${fmtHeure.format(new Date(releve.releveA))}`}
            {muets.length > 0 && (
              <span>
                {" · "}
                {muets.map((s) => s.name).join(", ")} : signal muet
              </span>
            )}
          </p>
          <h1 className="mt-1 font-titrage text-[clamp(2.6rem,6.5vw,6rem)] uppercase leading-[0.9]">
            {cat.label}
          </h1>
        </header>

        <Pulse
          key={releve?.releveA}
          rubrique={rubrique}
          liens={releve?.depeches.slice(0, 12).map((d) => d.lien) ?? []}
        />

        {releve && releve.depeches.length > 0 ? (
          <Riviere
            depeches={releve.depeches}
            rubrique={{ label: cat.label, folio }}
          />
        ) : (
          <p className="py-16 text-center font-telex text-sm uppercase tracking-[0.2em] text-encre-2">
            Signal muet sur toute la bande — repassez dans quelques minutes.
          </p>
        )}
      </div>
    </VT>
  );
}
