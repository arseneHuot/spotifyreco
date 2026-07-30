"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Récupère les écoutes récentes à l'ouverture de l'application.
 *
 * Ne rend rien : c'est un effet de bord volontairement invisible. L'utilisateur
 * n'a pas à demander une synchronisation, il veut juste retrouver ses écoutes à
 * jour en arrivant.
 *
 * Le serveur décide s'il y a lieu d'agir (moins de dix minutes depuis la
 * dernière fois : il ne fait rien). Le client se contente de le solliciter.
 */
export function AutoSync() {
  const router = useRouter();
  // React monte deux fois en mode strict : sans ce garde, deux requêtes
  // partiraient à chaque ouverture.
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    let cancelled = false;

    void fetch("/api/sync/auto", { method: "POST" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { skipped?: boolean; listens?: number } | null) => {
        // Ne rafraîchir que si l'écran a effectivement changé : un refresh
        // gratuit ferait clignoter la page à chaque ouverture.
        if (!cancelled && payload && !payload.skipped && payload.listens) {
          router.refresh();
        }
      })
      .catch(() => {
        // Silencieux par choix : une synchronisation d'arrière-plan qui échoue
        // ne doit pas alarmer. Le scheduler repassera dans dix minutes.
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
