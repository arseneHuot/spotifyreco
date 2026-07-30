import { readFileSync } from "node:fs";

/**
 * Charge `.env.local` avant l'évaluation des modules de test.
 *
 * Doit passer par `setupFiles` : les imports de haut niveau du fichier de test
 * sont évalués avant `beforeAll`, et les modules qui appellent `env()` à
 * l'import échoueraient sinon.
 */
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2];
  }
}
