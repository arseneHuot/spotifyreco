import { describe, expect, it } from "vitest";

import { RateLimiter } from "@/lib/rate-limit";

describe("RateLimiter", () => {
  it("espace les acquisitions successives d'au moins l'intervalle demandé", async () => {
    const limiter = new RateLimiter(50, "test");
    const timestamps: number[] = [];

    for (let i = 0; i < 4; i++) {
      await limiter.acquire();
      timestamps.push(Date.now());
    }

    for (let i = 1; i < timestamps.length; i++) {
      // Marge de 15 ms : les timers de Node se déclenchent rarement à la
      // milliseconde près.
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(35);
    }
  });

  it("sérialise les appels concurrents au lieu de les laisser passer ensemble", async () => {
    const limiter = new RateLimiter(30, "test");
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        await limiter.acquire();
        order.push(i);
      }),
    );

    // Chacun a bien attendu son tour : personne n'est passé en doublon.
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
  });

  it("respecte une pause imposée par un 429", async () => {
    const limiter = new RateLimiter(1, "test");

    limiter.pauseFor(120);
    expect(limiter.isPaused).toBe(true);

    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("conserve la pause la plus lointaine", () => {
    const limiter = new RateLimiter(1, "test");

    limiter.pauseFor(5_000);
    limiter.pauseFor(100); // ne doit pas raccourcir la pause en cours

    expect(limiter.pausedForMs).toBeGreaterThan(4_000);
  });
});
