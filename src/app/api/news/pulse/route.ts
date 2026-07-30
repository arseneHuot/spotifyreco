import { NextResponse, type NextRequest } from "next/server";

import { getReleve } from "@/lib/news/fetch";

/** Fenêtre de coalescence : une relève au plus par rubrique et par minute. */
const FENETRE_MS = 60_000;

type Entree = { expireA: number; liens: string[] };

/**
 * Réponses mémorisées par rubrique, à l'échelle du processus.
 *
 * Le cache de données de Next ne coalesce pas les requêtes concurrentes : sans
 * ce garde-fou, mille appels simultanés arrivant sur une entrée périmée
 * déclencheraient mille relèves parallèles, et l'application servirait
 * d'amplificateur vers les rédactions.
 */
const memo = new Map<string, Entree>();
const enCours = new Map<string, Promise<string[]>>();

async function liensDe(rubrique: string): Promise<string[]> {
  const frais = memo.get(rubrique);
  if (frais && frais.expireA > Date.now()) return frais.liens;

  const dejaLance = enCours.get(rubrique);
  if (dejaLance) return dejaLance;

  const travail = (async () => {
    const releve = await getReleve(rubrique);
    if (!releve) throw new Error("rubrique inconnue");
    const liens = releve.depeches.slice(0, 12).map((d) => d.lien);
    memo.set(rubrique, { expireA: Date.now() + FENETRE_MS, liens });
    return liens;
  })().finally(() => enCours.delete(rubrique));

  enCours.set(rubrique, travail);
  return travail;
}

/**
 * Le battement du direct : renvoie les derniers liens d'une rubrique pour que
 * le client sache s'il y a du neuf, sans recharger la page.
 */
export async function GET(request: NextRequest) {
  const rubrique = request.nextUrl.searchParams.get("rubrique") ?? "une";

  try {
    const liens = await liensDe(rubrique);
    return NextResponse.json(
      { liens },
      {
        headers: {
          // Le endpoint est public : on laisse le CDN absorber les rafales.
          "cache-control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      },
    );
  } catch {
    return NextResponse.json({ error: "rubrique inconnue" }, { status: 404 });
  }
}
