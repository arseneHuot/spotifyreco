/**
 * Point d'entrée exécuté une fois au démarrage du serveur.
 *
 * Il ne sert qu'à lancer les tâches périodiques quand l'hébergement fait
 * tourner un processus durable. Le garde sur `NEXT_RUNTIME` est nécessaire :
 * ce fichier est aussi évalué dans le runtime Edge, où ni les minuteurs longs
 * ni les modules serveur n'ont de sens.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
