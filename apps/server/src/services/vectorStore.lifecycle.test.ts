import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const scenario of ["concurrent", "independent", "retry"]) {
  test(`vector store lifecycle: ${scenario}`, async () => {
    const owned = await mkdtemp(path.join(os.tmpdir(), "openhorn-vector-init-"));
    try {
      const child = spawnSync(
        process.execPath,
        [new URL("./vectorStore.lifecycle.fixture.ts", import.meta.url).pathname, owned, scenario],
        {
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      if (child.status !== 0) throw new Error(child.stderr);
      const result = JSON.parse(await readFile(path.join(owned, "result.json"), "utf8"));
      if (scenario === "retry") expect(result).toEqual({ rejected: true, recovered: true });
      else
        expect(result).toEqual({
          rejected: 0,
          rows: 6,
          sentinel: 0,
          emptyAfterDelete: true,
          afterReadd: 1,
        });
    } finally {
      await rm(owned, { recursive: true, force: true });
    }
  });
}
