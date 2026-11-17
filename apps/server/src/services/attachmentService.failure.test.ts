import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const mode of ["upload", "upload-success", "upload-ack", "embedding"] as const) {
  test(`attachment lifecycle preserves owned files and protocol boundaries during ${mode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openhorn-attachment-failure-"));
    try {
      const child = spawnSync(
        process.execPath,
        [
          "--preload",
          new URL("../test-setup.ts", import.meta.url).pathname,
          new URL("./attachmentService.failure.fixture.ts", import.meta.url).pathname,
          root,
          mode,
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            NODE_ENV: "test",
            OPENHORN_TEST_DATABASE_URL: `file:${path.join(root, "fixture.db")}`,
            OPENHORN_DATA_DIR: root,
            ENCRYPTION_KEY: "attachment-failure-synthetic-key-only",
          },
        },
      );
      expect(child.status).toBe(0);
      if (child.status !== 0) throw new Error(child.stderr);
      const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"));
      if (mode.startsWith("upload")) {
        expect(result.rejected).toBe(mode !== "upload-success");
        expect(result.original).toBe("keep original");
        if (mode === "upload") {
          expect(result.remaining).toEqual(["original.txt"]);
          expect(result.storedRows).toBe(0);
        } else {
          expect(result.remaining).toHaveLength(2);
          expect(result.storedRows).toBe(1);
          expect(result.storedText).toBe("synthetic upload");
        }
      } else {
        expect(result.incompatibleRejected).toBe(true);
        expect(result.selectedApiKey).toBe(true);
        expect(result.baseUrl).toBe("https://fixture.invalid/v1");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
