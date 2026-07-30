"use client";

import { useEffect, useState } from "react";

/**
 * Heure absolue au rendu serveur, relative après hydratation.
 *
 * Le fuseau est figé sur Paris : l'heure absolue est ainsi identique entre le
 * serveur (UTC chez Vercel) et le navigateur — aucun mismatch d'hydratation.
 * Le relatif (« il y a 24 min ») dépend de l'horloge du client, donc il
 * n'apparaît qu'après montage, remis à jour chaque minute.
 */
const fmtHeure = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

function relatif(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

export function Horodatage({ iso }: { iso: string | null }) {
  const [texte, setTexte] = useState<string | null>(null);
  const [nouveau, setNouveau] = useState(false);

  useEffect(() => {
    if (!iso) return;
    const maj = () => {
      setTexte(relatif(iso));
      setNouveau(Date.now() - new Date(iso).getTime() < 3_600_000);
    };
    maj();
    const id = setInterval(maj, 60_000);
    return () => clearInterval(id);
  }, [iso]);

  if (!iso) return null;
  return (
    <>
      <time dateTime={iso}>{texte ?? fmtHeure.format(new Date(iso))}</time>
      {nouveau && (
        <span className="text-signal font-bold"> ● nouveau</span>
      )}
    </>
  );
}
