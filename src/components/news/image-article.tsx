"use client";

import { useState } from "react";

/**
 * Mire typographique : le fallback des images absentes ou mortes. Des barres
 * d'encre pur CSS et le folio de la rubrique — l'absence d'image devient un
 * parti pris graphique, pas un trou.
 */
export function Mire({ folio }: { folio: string }) {
  return (
    <div aria-hidden className="mire relative h-full w-full">
      <span className="absolute inset-0 grid place-items-center">
        <span className="bg-papier px-3 py-1 font-telex text-base font-bold tracking-[0.2em]">
          {folio}
        </span>
      </span>
    </div>
  );
}

/**
 * Les flux RSS pointent vers des dizaines de CDN différents : on reste sur un
 * <img> natif (recommandation de la doc locale de next/image pour des hôtes
 * arbitraires) avec la mire en secours quand l'hôte refuse le hotlink.
 */
export function ImageArticle({
  src,
  alt,
  folio,
}: {
  src: string;
  alt: string;
  folio: string;
}) {
  const [morte, setMorte] = useState(false);
  if (morte) return <Mire folio={folio} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- hôtes RSS arbitraires : next/image exigerait un remotePatterns ouvert
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="presse-img h-full w-full object-cover"
      onError={() => setMorte(true)}
    />
  );
}
