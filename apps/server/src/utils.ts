import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
/** AES-GCM's standard IV size. v1 ciphertexts carry 16 bytes and still decrypt. */
const IV_LENGTH = 12;

/** Marks a ciphertext whose key came from scrypt rather than a bare SHA-256. */
const V2_PREFIX = "v2";

/**
 * Fixed salt for the v2 key derivation.
 *
 * scrypt is deliberately slow, and a per-ciphertext random salt would mean
 * paying that cost on every single decrypt — channelService decrypts several
 * keys back-to-back while probing channels. The threat addressed here is
 * offline brute-force of ENCRYPTION_KEY, which a slow KDF already defeats; a
 * random salt would mainly add cross-deployment rainbow-table resistance, which
 * matters little for a single self-hosted master key.
 */
const V2_SALT = "openhorn.encryption.v2";

/**
 * scrypt cost. N=2^15 lands around 30-60ms per derivation — enough to make
 * large-scale guessing impractical, small enough to go unnoticed given the
 * result is cached for the process lifetime.
 *
 * `maxmem` must be raised explicitly: these parameters need roughly
 * 128 * N * r ≈ 33MB, just over Node's 32MB default, which otherwise fails with
 * MEMORY_LIMIT_EXCEEDED at the first encrypt.
 */
const V2_SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function readSecret(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY is not set");
  }
  return key;
}

/**
 * Legacy derivation: a single SHA-256 pass over the secret.
 *
 * Retained only to read ciphertexts written before v2. It has no KDF and no
 * salt, so a weak ENCRYPTION_KEY could be brute-forced at billions of guesses
 * per second — which is why new data no longer uses it.
 */
function deriveKeyV1(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

function deriveKeyV2(secret: string): Buffer {
  return crypto.scryptSync(secret, V2_SALT, 32, V2_SCRYPT_PARAMS);
}

// Derivation is pure but expensive, so cache it — keyed by the secret, so a
// rotated ENCRYPTION_KEY (in tests, or after a restart with a new value) is
// never served a stale key.
let cachedV2Key: Buffer | null = null;
let cachedV2Secret: string | null = null;

function getKeyV2(): Buffer {
  const secret = readSecret();
  if (cachedV2Key && cachedV2Secret === secret) return cachedV2Key;
  cachedV2Key = deriveKeyV2(secret);
  cachedV2Secret = secret;
  return cachedV2Key;
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyV2(), iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return `${V2_PREFIX}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

/** True when the stored value predates the scrypt derivation (3-part format). */
export function isLegacyCiphertext(encryptedText: string): boolean {
  return encryptedText.split(":").length === 3;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(":");

  // v2: "v2:<iv>:<tag>:<ciphertext>"   v1: "<iv>:<tag>:<ciphertext>"
  let key: Buffer;
  let ivHex: string;
  let tagHex: string;
  let payload: string;

  if (parts.length === 4 && parts[0] === V2_PREFIX) {
    key = getKeyV2();
    ivHex = parts[1] as string;
    tagHex = parts[2] as string;
    payload = parts[3] as string;
  } else if (parts.length === 3) {
    key = deriveKeyV1(readSecret());
    ivHex = parts[0] as string;
    tagHex = parts[1] as string;
    payload = parts[2] as string;
  } else {
    throw new Error("Invalid encrypted text format");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  let decrypted = decipher.update(payload, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function generateId(): string {
  return crypto.randomUUID();
}
