"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

const INTERVALLE_MS = 120_000;

/**
 * Le pouls du direct : toutes les deux minutes, on demande au serveur les
 * derniers liens de la rubrique (réponse servie depuis son cache — les
 * rédactions ne sont jamais martelées). S'il y a du neuf, une pilule propose
 * de rafraîchir ; rien ne bouge tout seul sous les yeux du lecteur.
 *
 * Le parent passe `key={releve.releveA}` : chaque nouvelle relève serveur
 * remonte le composant, ce qui remet naturellement la référence des liens
 * connus à zéro — aucun état à resynchroniser dans un effet.
 */
export function Pulse({
  rubrique,
  liens,
}: {
  rubrique: string;
  liens: string[];
}) {
  const router = useRouter();
  const [fraiches, setFraiches] = useState<string[]>([]);
  const [, startTransition] = useTransition();
  const connus = useRef<Set<string>>(new Set(liens));

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/news/pulse?rubrique=${encodeURIComponent(rubrique)}`,
        );
        if (!res.ok) return;
        const { liens: distants } = (await res.json()) as { liens: string[] };
        const inconnus = distants.filter((l) => !connus.current.has(l));
        if (inconnus.length) setFraiches(inconnus);
      } catch {
        // Réseau en carafe : on retentera au prochain battement.
      }
    }, INTERVALLE_MS);
    return () => clearInterval(id);
  }, [rubrique]);

  if (!fraiches.length) return null;

  return (
    <div className="sticky top-[104px] z-30 flex justify-center lg:top-3">
      <button
        type="button"
        onClick={() => {
          for (const l of fraiches) connus.current.add(l);
          setFraiches([]);
          startTransition(() => router.refresh());
        }}
        className="group border border-encre bg-papier px-4 py-1.5 font-telex text-[11px] font-bold uppercase tracking-[0.14em] shadow-none hover:bg-encre hover:text-papier"
      >
        <span className="text-signal group-hover:text-papier">▲</span>{" "}
        {fraiches.length}{" "}
        {fraiches.length > 1 ? "nouvelles dépêches" : "nouvelle dépêche"}
      </button>
    </div>
  );
}
