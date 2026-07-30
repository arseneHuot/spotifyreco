import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // La suite unitaire doit rester rapide et hors-ligne : tout ce qui touche
    // le réseau ou la base vit dans vitest.integration.config.ts.
    exclude: ["src/test/integration.test.ts", "src/test/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` lève une erreur dès qu'il est importé hors d'un
      // environnement serveur Next.js. Sous Vitest, on le neutralise.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
});
