import { expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_IMPORT_JSON_BYTES, prepareImportFile } from "./importService";

test("plain JSON imports reject files over the archive byte budget before reading them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-import-limit-"));
  const file = path.join(dir, "oversized.json");
  try {
    await writeFile(file, "");
    await truncate(file, MAX_IMPORT_JSON_BYTES + 1);
    let rejected = false;
    try {
      await prepareImportFile(file);
    } catch (error) {
      rejected = error instanceof Error && error.message === "Import JSON exceeds size limit";
    }
    expect(rejected).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
