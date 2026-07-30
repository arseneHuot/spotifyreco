import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Tests d'intégration : réseau réel + base réelle.
 * Séparés de la suite unitaire pour que `npm test` reste rapide et hors-ligne.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["src/test/load-env.ts"],
    include: ["src/test/*.integration.test.ts", "src/test/integration.test.ts"],
    testTimeout: 60_000,
    // Les API externes sont limitées en débit : les suites doivent s'exécuter
    // l'une après l'autre, sinon MusicBrainz (1 req/s) renvoie des 503.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
});
