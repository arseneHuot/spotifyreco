import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Les pochettes sont servies par le CDN de Spotify. Sans cette
    // autorisation explicite, `next/image` refuse l'hôte et n'affiche rien.
    remotePatterns: [{ protocol: "https", hostname: "i.scdn.co" }],
  },
  experimental: {
    // Utilisé par la section /news : le repère rouge de navigation glisse
    // d'une rubrique à l'autre et la rivière d'articles change par un balayage.
    // Sans support navigateur, la navigation reste un remplacement sec.
    viewTransition: true,
  },
};

export default nextConfig;
