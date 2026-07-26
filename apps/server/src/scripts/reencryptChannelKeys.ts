/**
 * Re-encrypts channel API keys from the legacy (v1) format to v2.
 *
 * v1 derived its AES key with a single SHA-256 pass over ENCRYPTION_KEY — no
 * KDF, no salt — so a weak secret was cheap to brute-force offline. v2 derives
 * via scrypt. Both formats decrypt transparently, so this migration is not
 * required for correctness; it exists so old rows stop being readable under the
 * weaker derivation.
 *
 * Runs read-only by default. Pass --apply to write.
 *
 *   pnpm --filter server run reencrypt          # report only
 *   pnpm --filter server run reencrypt --apply  # perform the migration
 */
import { channels } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { decrypt, encrypt, isLegacyCiphertext } from "../utils";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await db.select({ id: channels.id, apiKey: channels.apiKey }).from(channels);
  const legacy = rows.filter((row) => row.apiKey && isLegacyCiphertext(row.apiKey));

  console.log(`channels: ${rows.length} total, ${legacy.length} still on the v1 format`);
  if (legacy.length === 0) {
    console.log("nothing to do");
    return;
  }
  if (!apply) {
    console.log("dry run — re-run with --apply to migrate");
    return;
  }

  let migrated = 0;
  const failures: Array<{ id: string; reason: string }> = [];

  for (const row of legacy) {
    try {
      // Decrypt with the legacy key, re-encrypt under scrypt, and verify the
      // round-trip BEFORE writing. A row that cannot be read back is left
      // untouched rather than replaced with something unreadable.
      const plaintext = decrypt(row.apiKey);
      const reencrypted = encrypt(plaintext);
      if (decrypt(reencrypted) !== plaintext) {
        failures.push({ id: row.id, reason: "round-trip verification failed" });
        continue;
      }
      await db.update(channels).set({ apiKey: reencrypted }).where(eq(channels.id, row.id));
      migrated += 1;
    } catch (error) {
      failures.push({
        id: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(`migrated: ${migrated}/${legacy.length}`);
  for (const failure of failures) {
    console.error(`  failed ${failure.id}: ${failure.reason}`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
