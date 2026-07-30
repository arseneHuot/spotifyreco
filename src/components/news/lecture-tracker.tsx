"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

const CLE = "manchette:lus";
const MAX_LUS = 500;

/**
 * Marque en encre diluée les articles déjà ouverts. Le suivi vit dans
 * localStorage et s'applique en manipulant directement les liens rendus par
 * le serveur : un seul îlot client pour toute la rivière, plutôt qu'un
 * composant client par carte.
 */
export function LectureTracker() {
  const pathname = usePathname();

  useEffect(() => {
    let ensemble = new Set<string>();
    try {
      const brut: unknown = JSON.parse(localStorage.getItem(CLE) ?? "[]");
      // Une valeur du bon type mais non itérable (un nombre, un objet) ferait
      // échouer `new Set` et emporterait toute la section : on n'accepte que
      // ce que l'on a écrit soi-même.
      if (Array.isArray(brut)) {
        ensemble = new Set(brut.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      // Stockage corrompu : on repart de zéro.
    }

    for (const a of document.querySelectorAll<HTMLAnchorElement>(
      "a[data-article-link]",
    )) {
      if (ensemble.has(a.href)) a.classList.add("est-lu");
    }

    function onClick(e: MouseEvent) {
      const a = (e.target as HTMLElement).closest?.(
        "a[data-article-link]",
      ) as HTMLAnchorElement | null;
      if (!a) return;
      ensemble.add(a.href);
      a.classList.add("est-lu");
      try {
        localStorage.setItem(
          CLE,
          JSON.stringify([...ensemble].slice(-MAX_LUS)),
        );
      } catch {
        // Quota plein : tant pis, le marquage restera visuel pour la session.
      }
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [pathname]);

  return null;
}
