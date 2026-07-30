"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

import { VT } from "./vt";

export type RubriqueNav = {
  slug: string;
  label: string;
  href: string;
  folio: string;
};

const fmtDate = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Paris",
});

/**
 * « Le placard » : la navigation EST la typographie. Huit mots géants en
 * creux, le mot noir dit où l'on est. Colonne sticky sur desktop, rail
 * horizontal sticky sur mobile — même liste, même repère rouge (le « tally »
 * qui glisse d'un mot à l'autre en view transition).
 */
export function PlacardNav({ rubriques }: { rubriques: RubriqueNav[] }) {
  const pathname = usePathname();
  const router = useRouter();
  // La date n'apparaît qu'après hydratation : le HTML servi par l'ISR peut
  // avoir été généré la veille, on ne fige donc pas de date côté serveur.
  const dateJour = useSyncExternalStore(
    () => () => {},
    () => fmtDate.format(new Date()),
    () => "",
  );

  const indexActif = rubriques.findIndex((r) =>
    r.href === "/news"
      ? pathname === "/news"
      : pathname === r.href || pathname.startsWith(`${r.href}/`),
  );

  // Sur mobile, le rail défile : on ramène le mot actif dans le champ à
  // chaque navigation (block "nearest" pour ne jamais déplacer la page).
  useEffect(() => {
    document
      .querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // `e.target` n'est pas toujours un Element : un événement synthétique
      // émis sur `window` a `window` pour cible, et `closest` y est absent.
      const cible = e.target;
      if (
        cible instanceof Element &&
        cible.closest("input, textarea, select, [contenteditable]")
      ) {
        return;
      }

      const n = Number(e.key);
      if (n >= 1 && n <= rubriques.length) {
        router.push(rubriques[n - 1].href);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        const depart = indexActif === -1 ? 0 : indexActif;
        router.push(
          rubriques[(depart + delta + rubriques.length) % rubriques.length]
            .href,
        );
        return;
      }
      if (e.key === "j" || e.key === "k") {
        const liens = [
          ...document.querySelectorAll<HTMLAnchorElement>(
            "a[data-article-link]",
          ),
        ];
        if (!liens.length) return;
        const courant = liens.indexOf(
          document.activeElement as HTMLAnchorElement,
        );
        const suivant =
          e.key === "j"
            ? Math.min(courant + 1, liens.length - 1)
            : Math.max(courant - 1, 0);
        liens[suivant].focus({ preventScroll: true });
        liens[suivant].scrollIntoView({ block: "center" });
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [indexActif, rubriques, router]);

  return (
    <div className="sticky top-0 z-40 border-b border-encre bg-papier lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-b-0 lg:border-r lg:overflow-y-auto">
      {/* Manchette du journal — version desktop. */}
      <header className="hidden px-7 pt-7 pb-2 lg:block">
        <Link href="/news" className="font-titrage text-[3.2rem] leading-none">
          MANCHETTE
        </Link>
        <p
          className="mt-2 font-telex text-[11px] uppercase tracking-[0.14em] text-encre-2"
          aria-hidden={!dateJour}
        >
          {dateJour || " "}
        </p>
        <div className="mt-4 border-t-4 border-encre [border-top-style:double]" />
      </header>

      {/* Version mobile : logotype compact au-dessus du rail. */}
      <div className="flex items-baseline justify-between px-4 pt-3 lg:hidden">
        <Link href="/news" className="font-titrage text-2xl leading-none">
          MANCHETTE
        </Link>
        <span className="font-telex text-[10px] uppercase tracking-[0.14em] text-encre-2">
          {dateJour}
        </span>
      </div>

      <ul className="flex items-stretch gap-1 overflow-x-auto px-4 pb-0 [scrollbar-width:none] lg:flex-1 lg:flex-col lg:justify-evenly lg:gap-0 lg:overflow-visible lg:px-7 lg:pb-6">
        {rubriques.map((r, i) => {
          const actif = i === indexActif;
          return (
            <li key={r.slug} className="shrink-0 lg:shrink">
              <Link
                href={r.href}
                aria-current={actif ? "page" : undefined}
                className="group block px-2 py-2 lg:px-0 lg:py-1"
              >
                <span className="flex items-baseline gap-2 lg:gap-3">
                  <span
                    className={`font-telex text-[11px] font-bold [font-variant-numeric:tabular-nums] ${
                      actif ? "text-signal" : "text-encre-2"
                    }`}
                  >
                    {r.folio}
                  </span>
                  <span
                    className={`font-titrage uppercase leading-[0.92] tracking-[0.01em] text-[1.65rem] lg:text-[clamp(1.9rem,4.1vh,3.1rem)] ${
                      actif ? "text-encre" : "creux"
                    }`}
                  >
                    {r.label}
                  </span>
                </span>
                {/* Le tally : seul élément rouge du placard, il glisse d'un
                    mot à l'autre à la navigation (view transition). */}
                {actif ? (
                  <VT name="tally">
                    <span className="mt-1 block h-[3px] w-full bg-signal" />
                  </VT>
                ) : (
                  <span className="mt-1 block h-[3px] w-full" />
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="hidden px-7 pb-6 font-telex text-[10px] uppercase tracking-[0.14em] text-encre-2 lg:block">
        1–9 · ← → rubriques &nbsp; j/k dépêches
      </p>
    </div>
  );
}
