import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env";

/**
 * AES-256-GCM for secrets that must be stored but also read back: Ethereal SMTP
 * passwords and Slack incoming-webhook URLs.
 *
 * GCM rather than CBC because it is authenticated — tampering with a stored
 * ciphertext fails decryption instead of yielding plausible garbage that then
 * gets used as a webhook URL.
 *
 * Format: `v1.<iv>.<authTag>.<ciphertext>`, each part base64url.
 * The version prefix means the algorithm can be rotated later without having to
 * guess how any given row was encrypted.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const AUTH_TAG_BYTES = 16;

/** Parsed once: hex decoding on every send would be wasted work. */
const key: Buffer = Buffer.from(env.ENCRYPTION_KEY, "hex");

if (key.length !== 32) {
  // env.ts already enforces 64 hex chars; this guards against a future edit
  // loosening that regex without anyone noticing the consequence here.
  throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decrypt(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed ciphertext: expected 4 dot-separated parts");
  }

  const [version, ivPart, authTagPart, ciphertextPart] = parts as [string, string, string, string];
  if (version !== VERSION) {
    throw new Error(`Unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivPart, "base64url");
  const authTag = Buffer.from(authTagPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");

  if (iv.length !== IV_BYTES) {
    throw new Error(`Malformed ciphertext: IV must be ${IV_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`Malformed ciphertext: auth tag must be ${AUTH_TAG_BYTES} bytes`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Throws if the auth tag does not verify, which is the point of GCM.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Constant-time string comparison, for OAuth `state` and bull-board basic auth.
 * A plain `===` leaks length and prefix information through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token, for OAuth state and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
