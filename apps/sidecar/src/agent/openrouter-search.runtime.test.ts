import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const runtime of ["direct", "claude"]) {
  for (const provider of ["openrouter", "tavily"]) {
    test(`${runtime} runtime carries ${provider} credentials and provenance through an actual Search tool round`, () => {
      const owned = mkdtempSync(path.join(tmpdir(), "openhorn-openrouter-runtime-"));
      try {
        const child = Bun.spawnSync(
          [
            process.execPath,
            new URL("./openrouter-search.runtime.fixture.ts", import.meta.url).pathname,
            owned,
            runtime,
            provider,
          ],
          {
            env: { ...process.env, OPENHORN_HOME: path.join(owned, "home") },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 20_000,
          },
        );
        if (child.exitCode !== 0)
          throw new Error(child.stderr.toString() + child.stdout.toString());
        expect(JSON.parse(child.stdout.toString())).toEqual({
          searchRequests: 1,
          modelRequests: 2,
          separatedCredentials: true,
        });
      } finally {
        rmSync(owned, { recursive: true, force: true });
      }
    });
  }
}
