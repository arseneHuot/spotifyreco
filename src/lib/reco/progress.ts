/**
 * Progression d'une génération.
 *
 * Une génération complète dure une à deux minutes, dont l'essentiel dans un
 * appel au modèle qui ne rend la main qu'à la fin. Sans retour, l'attente est
 * indistinguable d'un blocage. Les étapes émises ici sont donc les étapes
 * réelles du moteur — pas une animation décorative : chaque `at` correspond à
 * un travail effectivement commencé.
 *
 * `at` est la position de la barre au moment de l'émission. Les deux phases
 * longues — l'appel au modèle et la vérification des suggestions — émettent
 * régulièrement une position intermédiaire calculée sur leur avancement réel
 * (tokens produits, suggestions vérifiées), sans jamais atteindre le jalon
 * suivant : celui-ci appartient à un travail qui n'a pas commencé.
 */
export type ProgressEvent =
  | {
      type: "step";
      /** Position de la barre, entre 0 et 1. */
      at: number;
      /** Ce qui se passe, à la première personne du moteur. */
      label: string;
      /** Avancement fin d'une étape itérative, quand il est connu. */
      done?: number;
      total?: number;
    }
  | { type: "done"; result: unknown }
  | { type: "error"; error: string };

export type ProgressReporter = (event: ProgressEvent) => void;

/**
 * Jalons de la barre selon les moteurs demandés.
 *
 * Les bornes sont réparties d'après le temps observé : l'appel au modèle
 * occupe à lui seul l'essentiel d'une génération complète (mesuré à ~80 s sur
 * ~110 s), d'où l'intervalle `model` → `grounding`, le plus large de la table.
 */
export type Milestones = ReturnType<typeof milestones>;

export function milestones(wantsAi: boolean, wantsAlgo: boolean) {
  if (wantsAi && wantsAlgo) {
    return {
      profile: 0.03,
      catalog: 0.08,
      candidates: 0.2,
      ranking: 0.28,
      portrait: 0.32,
      model: 0.38,
      grounding: 0.78,
      persist: 0.95,
    };
  }

  if (wantsAi) {
    return {
      profile: 0.04,
      catalog: 0.04,
      candidates: 0.04,
      ranking: 0.04,
      portrait: 0.08,
      model: 0.15,
      grounding: 0.72,
      persist: 0.95,
    };
  }

  // Moteur maison seul : quelques secondes, dominées par l'expansion du
  // catalogue et ses appels réseau.
  return {
    profile: 0.05,
    catalog: 0.15,
    candidates: 0.6,
    ranking: 0.8,
    portrait: 0.9,
    model: 0.9,
    grounding: 0.9,
    persist: 0.92,
  };
}
