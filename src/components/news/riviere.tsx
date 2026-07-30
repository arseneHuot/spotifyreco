import type { Depeche } from "@/lib/news/fetch";

import {
  CarteCourante,
  CarteManchette,
  RangeeCassee,
  type RubriqueCarte,
} from "./carte";
import { LectureTracker } from "./lecture-tracker";

const fmtHeure = new Intl.DateTimeFormat("fr-FR", {
  hour: "numeric",
  timeZone: "Europe/Paris",
});
const fmtJour = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Paris",
});

type Bloc =
  | { genre: "separateur"; label: string; jour: boolean }
  | { genre: "rangee"; taille: number; deps: Depeche[] };

/**
 * Rythme éditorial de la rivière : manchette (1), tierce (3), grille cassée
 * (2), tierce (3), et on recommence. Le motif traverse les heures ; un
 * séparateur d'heure interrompt la rangée en cours.
 */
const MOTIF = [1, 3, 2, 3];

function decoupeEnBlocs(deps: Depeche[]): Bloc[] {
  const blocs: Bloc[] = [];
  let heureCourante: string | null = null;
  let jourCourant: string | null = null;
  let motifIndex = 0;
  let tampon: Depeche[] = [];

  const vide = () => {
    if (!tampon.length) return;
    blocs.push({ genre: "rangee", taille: MOTIF[motifIndex], deps: tampon });
    motifIndex = (motifIndex + 1) % MOTIF.length;
    tampon = [];
  };

  for (const dep of deps) {
    if (dep.date) {
      const d = new Date(dep.date);
      const jour = fmtJour.format(d);
      const heure = `${jour} ${fmtHeure.format(d)}`;
      if (heure !== heureCourante) {
        vide();
        const changeJour = jour !== jourCourant && jourCourant !== null;
        blocs.push({
          genre: "separateur",
          label: changeJour ? jour : fmtHeure.format(d),
          jour: changeJour,
        });
        heureCourante = heure;
        jourCourant = jour;
      }
    }
    tampon.push(dep);
    if (tampon.length === MOTIF[motifIndex]) vide();
  }
  vide();
  return blocs;
}

function Separateur({ label, jour }: { label: string; jour: boolean }) {
  return (
    <div
      className={`z-20 bg-papier py-2 text-center lg:sticky lg:top-0 ${
        jour
          ? "border-t-4 border-encre [border-top-style:double]"
          : "border-t border-encre"
      }`}
    >
      <span className="font-telex text-[11px] font-bold uppercase tracking-[0.3em] text-encre-2">
        — {label} —
      </span>
    </div>
  );
}

export function Riviere({
  depeches,
  rubrique,
}: {
  depeches: Depeche[];
  rubrique: RubriqueCarte;
}) {
  const blocs = decoupeEnBlocs(depeches);

  return (
    <div>
      <LectureTracker />
      {blocs.map((bloc, i) => {
        if (bloc.genre === "separateur") {
          return <Separateur key={i} label={bloc.label} jour={bloc.jour} />;
        }
        if (bloc.taille === 1) {
          return (
            <div key={i} className="border-t border-filet-faible first:border-t-0">
              <CarteManchette dep={bloc.deps[0]} rubrique={rubrique} />
            </div>
          );
        }
        if (bloc.taille === 2 && bloc.deps.length === 2) {
          return (
            <div key={i} className="border-t border-filet-faible">
              <RangeeCassee deps={bloc.deps} rubrique={rubrique} />
            </div>
          );
        }
        // Tierce — et rangées incomplètes en fin d'heure ou de rivière.
        return (
          <div
            key={i}
            className={`grid grid-cols-1 border-t border-filet-faible lg:gap-0 ${
              bloc.deps.length >= 3
                ? "lg:grid-cols-3 lg:divide-x lg:divide-filet-faible"
                : bloc.deps.length === 2
                  ? "lg:grid-cols-2 lg:divide-x lg:divide-filet-faible"
                  : ""
            }`}
          >
            {bloc.deps.map((dep) => (
              <div key={dep.lien} className="lg:px-6 first:lg:pl-0 last:lg:pr-0">
                <CarteCourante dep={dep} rubrique={rubrique} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
