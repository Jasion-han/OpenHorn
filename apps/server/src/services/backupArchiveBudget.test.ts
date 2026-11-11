import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BACKUP_ARCHIVE_LIMITS, BackupArchiveBudget } from "./backupArchiveBudget";

test("actual streamed attachment bytes cannot cross the restore aggregate budget", async () => {
  const budget = new BackupArchiveBudget();
  for (let i = 0; i < 3; i++) budget.addEntry(`part-${i}`, BACKUP_ARCHIVE_LIMITS.entryBytes);
  budget.addEntry("last-metadata", BACKUP_ARCHIVE_LIMITS.entryBytes - 2);
  const bounded = budget.attachment("growing-original");
  bounded.resume();
  let code: unknown;
  try {
    await pipeline(Readable.from([Buffer.from("123")]), bounded);
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code).toBe("backup_size_limit");
});

test("archive identities and per-entry limits use the same policy for every entry", () => {
  const budget = new BackupArchiveBudget();
  budget.addEntry("one", 0);
  for (const [name, size] of [
    ["one", 0],
    ["large", BACKUP_ARCHIVE_LIMITS.entryBytes + 1],
  ] as const) {
    let code: unknown;
    try {
      budget.addEntry(name, size);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("backup_size_limit");
  }
});
