import { CATEGORIES } from "@/lib/news/feeds";

/**
 * « L'ours » : comme dans un journal imprimé, la liste complète de qui écrit
 * quoi — ici, les flux publics relevés par rubrique.
 */
export function Ours() {
  return (
    <footer className="border-t-4 border-encre px-4 py-10 [border-top-style:double] lg:px-10">
      <h2 className="font-titrage text-2xl uppercase">L&rsquo;ours</h2>
      <p className="mt-2 max-w-[70ch] font-texte text-[14px] italic leading-[1.55] text-encre-2">
        Manchette est un kiosque, pas un miroir : chaque titre ouvre
        l&rsquo;article chez son éditeur. Les flux publics ci-dessous sont
        relevés toutes les cinq minutes.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {CATEGORIES.map((cat) => (
          <div key={cat.slug}>
            <h3 className="border-t border-encre pt-2 font-telex text-[11px] font-bold uppercase tracking-[0.14em]">
              {cat.label}
            </h3>
            <ul className="mt-2 space-y-1">
              {cat.sources.map((s) => (
                <li
                  key={s.url}
                  className="font-telex text-[11px] uppercase text-encre-2"
                >
                  {s.name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-8 border-t border-filet-faible pt-3 font-telex text-[10px] uppercase tracking-[0.14em] text-encre-2">
        Composé en Anton, Archivo, Spectral &amp; Space Mono · Aucun cookie,
        aucune inscription
      </p>
    </footer>
  );
}
