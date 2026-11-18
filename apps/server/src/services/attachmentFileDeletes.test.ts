import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("rolled-back deletes preserve originals and committed deletes recover in another process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openhorn-cleanup-"));
  try {
    for (const phase of ["delete", "restart"]) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          new URL("./attachmentFileDeletes.fixture.ts", import.meta.url).pathname,
          phase,
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            DATABASE_URL: `file:${path.join(root, "temporary.db")}`,
            OPENHORN_DATA_DIR: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (child.exitCode) throw new Error(child.stderr.toString());
      expect(child.exitCode).toBe(0);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
