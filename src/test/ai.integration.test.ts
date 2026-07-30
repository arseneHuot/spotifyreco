import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT, existsAsRecording, suggestionSchema } from "@/lib/reco/ai";

/**
 * Test d'intégration du moteur IA : appels réels à Claude et à MusicBrainz.
 *
 * Il mesure ce qui décide de l'utilité du moteur — le taux d'hallucination.
 * Un modèle de langage produit des titres plausibles qui n'existent pas ; si la
 * proportion de morceaux introuvables est élevée, le prompt est à revoir.
 *
 *   npx vitest run --config vitest.integration.config.ts src/test/ai.integration.test.ts
 */

// Profil volontairement pointu : les goûts de niche sont exactement là où un
// modèle est tenté d'inventer, faute de connaître assez de catalogue.
const PORTRAIT = `Genres et ambiances recherchés : shoegaze, dream pop, post-punk, cold wave, noise pop, ethereal, 80s underground, reverb-heavy, melancholic.
Registres explicitement rejetés (notes 0 ou 1) : eurodance, happy hardcore, comedy. Évite-les.
Artistes déjà appréciés (ne les propose pas, sers-t'en comme repères) : Slowdive, Cocteau Twins, The Chameleons, Chapterhouse.
Profil sonore moyen : énergie 45/100, dansabilité 38/100, humeur (0 = sombre, 100 = joyeux) 28/100, acoustique 22/100, instrumental 61/100 (mais goût très ouvert sur ce point).
Le profil repose sur 180 signaux (indice de confiance 0.72/1).`;

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!HAS_KEY)("moteur IA — appel réel à Claude Opus 5", () => {
  it(
    "renvoie des suggestions structurées et majoritairement réelles",
    async () => {
      const client = new Anthropic();

      const response = await client.messages.parse({
        model: "claude-opus-5",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: zodOutputFormat(suggestionSchema),
        },
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `Voici le profil. Propose 12 morceaux.\n\n${PORTRAIT}`,
          },
        ],
      });

      // Les classificateurs peuvent décliner : c'est un 200 avec content vide.
      expect(response.stop_reason).not.toBe("refusal");

      const parsed = response.parsed_output;
      expect(parsed).not.toBeNull();

      const suggestions = parsed!.suggestions;
      expect(suggestions.length).toBeGreaterThanOrEqual(8);

      // --- Contrat de structure ---------------------------------------------
      for (const s of suggestions) {
        expect(s.artist.trim().length).toBeGreaterThan(0);
        expect(s.title.trim().length).toBeGreaterThan(0);
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
        expect(["evident", "adjacent", "lointain"]).toContain(s.familiarity);
      }

      // --- Consignes du prompt ----------------------------------------------
      const artists = suggestions.map((s) => s.artist.toLowerCase().trim());
      expect(new Set(artists).size).toBe(artists.length); // pas de doublon d'artiste

      // Les artistes déjà connus ne doivent pas être reproposés.
      for (const known of ["slowdive", "cocteau twins", "the chameleons"]) {
        expect(artists).not.toContain(known);
      }

      // La variété est l'exigence produit : un lot mono-registre est un échec.
      const registres = new Set(suggestions.map((s) => s.familiarity));
      expect(registres.size).toBeGreaterThanOrEqual(2);

      // --- Taux d'hallucination (le vrai test) ------------------------------
      const checks = [];
      for (const s of suggestions.slice(0, 12)) {
        // Séquentiel : MusicBrainz impose 1 requête par seconde.
        const real = await existsAsRecording(s.artist, s.title);
        checks.push({ ...s, real });
      }

      const real = checks.filter((c) => c.real);
      const fake = checks.filter((c) => !c.real);
      const rate = real.length / checks.length;

      console.log(
        `\n  Morceaux confirmés dans MusicBrainz : ${real.length}/${checks.length} (${Math.round(rate * 100)} %)`,
      );
      for (const c of checks) {
        console.log(
          `    ${c.real ? "OK " : "REJ"} [${c.familiarity}] ${c.artist} — ${c.title}`,
        );
      }
      if (fake.length > 0) {
        console.log(
          `  Écartés : ${fake.map((c) => `${c.artist} — ${c.title}`).join(" | ")}`,
        );
      }

      // Seuil délibérément bas : le filtre existe précisément parce que le
      // modèle se trompe parfois. Ce qui compte, c'est qu'il reste assez de
      // morceaux valides pour composer un lot.
      expect(real.length).toBeGreaterThanOrEqual(5);
    },
    240_000,
  );
});

describe("ancrage MusicBrainz", () => {
  it("confirme un morceau réel et rejette un morceau inventé", async () => {
    // Vérité terrain : ce morceau existe.
    expect(await existsAsRecording("Slowdive", "Alison")).toBe(true);

    // Titre volontairement absurde : c'est le cas qu'un LLM produit quand il
    // hallucine, et que le filtre doit intercepter.
    expect(
      await existsAsRecording("Slowdive", "Xyzzy Quorblat Nine Nine Nine"),
    ).toBe(false);
  }, 60_000);
});
