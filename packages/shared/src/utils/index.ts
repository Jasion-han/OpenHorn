import crypto from "node:crypto";

/**
 * Encrypt/decrypt used to live here as a byte-for-byte duplicate of
 * `apps/server/src/utils.ts`. Nothing imported this copy, but keeping two
 * independent implementations of the same ciphertext format was a live hazard:
 * upgrading one (the server side now derives its key with scrypt and tags
 * ciphertexts `v2:`) would leave the other silently writing data the first
 * could not read — with no type error and no test failure to catch it.
 *
 * The server module is the single source of truth. Anything that needs to
 * encrypt must go through it, so that key derivation and the ciphertext format
 * can only ever change in one place.
 */

export function generateId(): string {
  return crypto.randomUUID();
}
