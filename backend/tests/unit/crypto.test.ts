import { describe, expect, it } from "vitest";
import { decrypt, encrypt, randomToken, safeEqual } from "../../src/lib/crypto";

/**
 * These are the guarantees the rest of the system relies on: Slack webhook URLs
 * and Ethereal SMTP passwords are stored as ciphertext and must come back
 * byte-identical, and a tampered value must fail loudly rather than decrypt
 * into something that gets used as a URL.
 */
describe("crypto", () => {
  describe("encrypt / decrypt", () => {
    it("round-trips a value unchanged", () => {
      const plaintext = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });

    it("round-trips unicode and empty strings", () => {
      for (const value of ["", "päßwörd-✉️-日本語", " leading and trailing "]) {
        expect(decrypt(encrypt(value))).toBe(value);
      }
    });

    it("produces a different ciphertext each time for the same input", () => {
      // A fresh random IV per call. Identical ciphertexts would leak that two
      // senders share a password.
      const a = encrypt("same-secret");
      const b = encrypt("same-secret");
      expect(a).not.toBe(b);
      expect(decrypt(a)).toBe(decrypt(b));
    });

    it("emits the versioned four-part format", () => {
      const parts = encrypt("value").split(".");
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("v1");
    });

    it("rejects a tampered ciphertext", () => {
      const encrypted = encrypt("original-secret");
      const parts = encrypted.split(".");
      // Flip a character in the ciphertext segment.
      const ciphertext = parts[3] as string;
      const flipped = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
      const tampered = [parts[0], parts[1], parts[2], flipped].join(".");

      // GCM authentication is the whole reason for choosing it over CBC.
      expect(() => decrypt(tampered)).toThrow();
    });

    it("rejects a tampered auth tag", () => {
      const parts = encrypt("original-secret").split(".");
      const tag = parts[2] as string;
      const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
      expect(() => decrypt([parts[0], parts[1], flipped, parts[3]].join("."))).toThrow();
    });

    it("rejects malformed input", () => {
      expect(() => decrypt("not-a-ciphertext")).toThrow(/Malformed ciphertext/);
      expect(() => decrypt("a.b.c")).toThrow(/expected 4 dot-separated parts/);
      expect(() => decrypt("v2.aaaa.bbbb.cccc")).toThrow(/Unsupported ciphertext version/);
    });

    it("rejects a ciphertext whose IV is the wrong length", () => {
      const parts = encrypt("value").split(".");
      const shortIv = Buffer.from("short").toString("base64url");
      expect(() => decrypt([parts[0], shortIv, parts[2], parts[3]].join("."))).toThrow(
        /IV must be 12 bytes/,
      );
    });
  });

  describe("safeEqual", () => {
    it("matches identical strings and rejects everything else", () => {
      expect(safeEqual("oauth-state-abc", "oauth-state-abc")).toBe(true);
      expect(safeEqual("oauth-state-abc", "oauth-state-abd")).toBe(false);
      // Differing lengths must return false rather than throw, which is what
      // timingSafeEqual does on its own.
      expect(safeEqual("short", "considerably-longer")).toBe(false);
      expect(safeEqual("", "")).toBe(true);
    });
  });

  describe("randomToken", () => {
    it("returns distinct URL-safe tokens", () => {
      const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
      expect(tokens.size).toBe(100);
      for (const token of tokens) {
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });
  });
});
