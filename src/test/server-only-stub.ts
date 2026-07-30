// Remplace le paquet `server-only` sous Vitest : les tests s'exécutent dans
// Node, hors du runtime serveur de Next.js, et l'import réel échouerait.
export {};
