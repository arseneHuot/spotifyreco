import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { env } from "@/lib/env";

/**
 * Chiffrement applicatif des refresh tokens Spotify.
 *
 * Pourquoi pas les mécanismes Postgres :
 *  - `pgsodium` est officiellement en voie de dépréciation, et Supabase
 *    déconseille explicitement Transparent Column Encryption.
 *  - Supabase Vault chiffre bien, mais `vault.secrets` est une table globale à
 *    noms uniques, sans RLS naturelle : ce n'est pas conçu pour du secret
 *    par utilisateur et par ligne.
 *
 * La recommandation officielle pour les provider tokens est de les confier à
 * « a trusted and secure server you control ». On chiffre donc en AES-256-GCM
 * côté serveur, avec une clé qui ne se trouve jamais dans la base : quelqu'un
 * qui obtient un dump Postgres n'obtient pas les tokens.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, taille recommandée pour GCM
const AUTH_TAG_LENGTH = 16;
const VERSION = "v1";

function key(): Buffer {
  return Buffer.from(env().TOKEN_ENCRYPTION_KEY, "base64");
}

/**
 * Chiffre une chaîne. Format : `v1.<iv>.<authTag>.<ciphertext>`, chaque segment
 * en base64url. Le préfixe de version permet de faire tourner l'algorithme plus
 * tard sans invalider les données existantes.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Déchiffre une valeur produite par `encrypt`.
 *
 * Lève si le texte a été altéré : GCM authentifie le chiffré, donc toute
 * modification d'un octet est détectée plutôt que de produire silencieusement
 * des octets aléatoires.
 */
export function decrypt(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new Error("Payload chiffré malformé");
  }

  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Version de chiffrement non supportée : ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(dataB64, "base64url");

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Payload chiffré malformé");
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Comparaison à temps constant pour les secrets partagés (en-tête du cron).
 * `===` sur une chaîne s'arrête au premier octet différent et laisse fuiter le
 * préfixe correct via le temps de réponse.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
