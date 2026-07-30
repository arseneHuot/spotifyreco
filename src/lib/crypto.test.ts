import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // 32 octets, comme l'exige AES-256.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_SECRET_KEY = "secret";
  process.env.SPOTIFY_CLIENT_ID = "id";
  process.env.SPOTIFY_CLIENT_SECRET = "secret";
  process.env.CRON_SECRET = "0123456789abcdef0123456789abcdef";
});

const { encrypt, decrypt, safeCompare } = await import("@/lib/crypto");

describe("encrypt / decrypt", () => {
  it("fait l'aller-retour sur un refresh token", () => {
    const token = "AQD3x_faux_refresh_token_spotify-avec.des_caracteres";
    expect(decrypt(encrypt(token))).toBe(token);
  });

  it("gère l'unicode et les chaînes vides", () => {
    for (const value of ["", "éàü 🎧 音楽", "a".repeat(5000)]) {
      expect(decrypt(encrypt(value))).toBe(value);
    }
  });

  it("produit un chiffré différent à chaque appel", () => {
    // L'IV est aléatoire : deux chiffrés identiques trahiraient un IV figé, ce
    // qui casse la sécurité de GCM.
    const a = encrypt("même-valeur");
    const b = encrypt("même-valeur");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it("rejette un chiffré altéré plutôt que de renvoyer des octets faux", () => {
    const payload = encrypt("secret");
    const [version, iv, tag, data] = payload.split(".");

    // On modifie un caractère du texte chiffré.
    const flipped = data[0] === "A" ? `B${data.slice(1)}` : `A${data.slice(1)}`;

    expect(() => decrypt([version, iv, tag, flipped].join("."))).toThrow();
  });

  it("rejette un tag d'authentification invalide", () => {
    const payload = encrypt("secret");
    const [version, iv, , data] = payload.split(".");
    const forgedTag = Buffer.alloc(16, 1).toString("base64url");

    expect(() => decrypt([version, iv, forgedTag, data].join("."))).toThrow();
  });

  it("rejette un format inconnu", () => {
    expect(() => decrypt("pas-un-payload")).toThrow(/malformé/);
    expect(() => decrypt("v2.a.b.c")).toThrow(/non supportée/);
  });
});

describe("safeCompare", () => {
  it("compare correctement", () => {
    expect(safeCompare("secret", "secret")).toBe(true);
    expect(safeCompare("secret", "secrez")).toBe(false);
    expect(safeCompare("secret", "secret-plus-long")).toBe(false);
    expect(safeCompare("", "")).toBe(true);
  });
});
