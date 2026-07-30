import type { Metadata } from "next";
import { Anton, Archivo, Space_Mono, Spectral } from "next/font/google";
import { Suspense } from "react";

import { Cordon } from "@/components/news/cordon";
import { Ours } from "@/components/news/ours";
import { PlacardNav } from "@/components/news/placard-nav";
import { CATEGORIES } from "@/lib/news/feeds";

/**
 * Les quatre voix de Manchette : Anton pour l'affiche, Archivo pour la
 * titraille courante, Spectral pour la lecture, Space Mono pour la machine.
 * Déclarées ici, elles ne sont chargées que sur la section /news.
 */
const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-anton",
  display: "swap",
});
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});
const spectral = Spectral({
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-spectral",
  display: "swap",
});
const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-space-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Manchette — l'actualité composée en corps 120",
    template: "%s — Manchette",
  },
  description:
    "La presse française relevée toutes les cinq minutes et composée comme une affiche : neuf rubriques, quarante flux publics, zéro compte à créer.",
};

export default function NewsLayout({ children }: LayoutProps<"/news">) {
  const rubriques = CATEGORIES.map((c, i) => ({
    slug: c.slug,
    label: c.label,
    href: c.slug === "une" ? "/news" : `/news/${c.slug}`,
    folio: String(i + 1).padStart(2, "0"),
  }));

  return (
    <div
      className={`manchette ${anton.variable} ${archivo.variable} ${spectral.variable} ${spaceMono.variable} min-h-dvh w-full bg-papier font-titre text-encre`}
    >
      <div className="barre-lecture" aria-hidden />
      {/* Le cordon fetch la Une : sous Suspense pour ne jamais bloquer la
          navigation depuis le layout (piège documenté du fetch en layout). */}
      <Suspense
        fallback={
          <div className="h-[38px] border-b-4 border-encre [border-bottom-style:double]" />
        }
      >
        <Cordon />
      </Suspense>
      <div className="lg:grid lg:grid-cols-[380px_minmax(0,1fr)]">
        <PlacardNav rubriques={rubriques} />
        <main className="min-w-0 px-4 lg:px-10">{children}</main>
      </div>
      <Ours />
    </div>
  );
}
