import { getReleve } from "@/lib/news/fetch";

const fmtHeure = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

/**
 * Le cordon « Dernière heure » : les huit titres les plus récents de la Une
 * en marquee CSS, hommage au téléscripteur. La piste est dupliquée pour que
 * la boucle translateX(-50%) soit invisible ; pause au survol.
 */
export async function Cordon() {
  const releve = await getReleve("une");
  const derniers = releve?.depeches.slice(0, 8) ?? [];
  if (!derniers.length) return null;

  const piste = (ariaHidden: boolean) => (
    <span aria-hidden={ariaHidden} className="flex shrink-0 items-baseline">
      {derniers.map((dep) => (
        <a
          key={dep.lien}
          href={dep.lien}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={ariaHidden ? -1 : undefined}
          className="mx-8 inline-flex items-baseline gap-2 hover:text-signal"
        >
          {dep.date && (
            <span className="[font-variant-numeric:tabular-nums]">
              {fmtHeure.format(new Date(dep.date))}
            </span>
          )}
          <span className="normal-case">{dep.titre}</span>
        </a>
      ))}
    </span>
  );

  return (
    <div className="cordon flex items-stretch border-b-4 border-encre [border-bottom-style:double]">
      <span className="shrink-0 border-r border-encre px-4 py-2 font-telex text-[11px] font-bold uppercase tracking-[0.2em]">
        <span className="text-signal">●</span> Dernière heure
      </span>
      <div className="relative flex-1 overflow-hidden">
        <div className="cordon-piste flex w-max py-2 font-telex text-[12px] uppercase">
          {piste(false)}
          {piste(true)}
        </div>
      </div>
    </div>
  );
}
