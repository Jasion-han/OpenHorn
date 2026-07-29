import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { decrypt, encrypt, isLegacyCiphertext } from "./utils";

/**
 * Builds a ciphertext exactly the way the pre-scrypt implementation did:
 * a bare SHA-256 of the secret, a 16-byte IV, and no version prefix.
 * Needed to prove existing rows keep decrypting after the upgrade.
 */
function encryptLegacy(text: string, secret: string): string {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

const SECRET = "test-encryption-key-for-unit-tests";

function withSecret<T>(fn: () => T): T {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = SECRET;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
}

describe("encrypt / decrypt", () => {
  test("round-trips a value", () => {
    withSecret(() => {
      const plaintext = "sk-test-abc123";
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  test("new ciphertexts carry the v2 marker", () => {
    withSecret(() => {
      const parts = encrypt("x").split(":");
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe("v2");
    });
  });

  test("the same plaintext encrypts differently each time (random IV)", () => {
    withSecret(() => {
      // Bound to two names on purpose: the two calls look identical but are not
      // — encrypt draws a fresh IV each time, which is exactly what this asserts.
      const first = encrypt("same");
      const second = encrypt("same");
      expect(first === second).toBe(false);
    });
  });

  test("round-trips unicode and long values", () => {
    withSecret(() => {
      const plaintext = `密钥-${"x".repeat(500)}-🔐`;
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  // The whole point of versioning: upgrading key derivation must not orphan
  // data written by the old one.
  test("still decrypts legacy v1 ciphertexts", () => {
    withSecret(() => {
      const plaintext = "sk-legacy-value";
      expect(decrypt(encryptLegacy(plaintext, SECRET))).toBe(plaintext);
    });
  });

  test("v1 and v2 of the same plaintext both decrypt to it", () => {
    withSecret(() => {
      const plaintext = "sk-both-formats";
      expect(decrypt(encryptLegacy(plaintext, SECRET))).toBe(plaintext);
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  test("a tampered auth tag is rejected", () => {
    withSecret(() => {
      const parts = encrypt("sensitive").split(":");
      const tag = parts[2] as string;
      // Flip one hex digit of the tag.
      const flipped = (tag[0] === "0" ? "1" : "0") + tag.slice(1);
      parts[2] = flipped;
      let threw = false;
      try {
        decrypt(parts.join(":"));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  test("a malformed value is rejected", () => {
    withSecret(() => {
      for (const bad of ["", "nope", "a:b", "v2:a:b"]) {
        let threw = false;
        try {
          decrypt(bad);
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      }
    });
  });

  test("a different secret cannot decrypt", () => {
    const ciphertext = withSecret(() => encrypt("sk-secret"));
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "a-completely-different-secret";
    let threw = false;
    try {
      decrypt(ciphertext);
    } catch {
      threw = true;
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previous;
    }
    expect(threw).toBe(true);
  });

  test("missing ENCRYPTION_KEY is reported", () => {
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    let message = "";
    try {
      encrypt("x");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    } finally {
      if (previous !== undefined) process.env.ENCRYPTION_KEY = previous;
    }
    expect(message).toBe("ENCRYPTION_KEY is not set");
  });
});

describe("isLegacyCiphertext", () => {
  test("recognises the 3-part v1 format", () => {
    withSecret(() => {
      expect(isLegacyCiphertext(encryptLegacy("x", SECRET))).toBe(true);
    });
  });

  test("does not flag v2", () => {
    withSecret(() => {
      expect(isLegacyCiphertext(encrypt("x"))).toBe(false);
    });
  });
});
