import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

for (const scenario of ["approval", "backup", "running", "pre-aborted"]) {
  test(`Anthropic protocol Stop during ${scenario} prevents later tool effects`, async () => {
    const owned = await realpath(await mkdtemp(path.join(tmpdir(), "openhorn-stop-fixture-")));
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./claude.cancellation.fixture.ts", import.meta.url).pathname,
        owned,
        scenario,
      ],
      {
        env: { ...process.env, OPENHORN_HOME: path.join(owned, "snapshots") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    try {
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
      const result = JSON.parse(await readFile(path.join(owned, "result.json"), "utf8"));
      expect(result.marker).toBe(null);
      if (scenario === "pre-aborted") expect(result.streams).toBe(0);
      else expect(result.streams).toBe(1);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await Promise.all([out, errors]);
      await rm(owned, { recursive: true, force: true });
    }
  }, 10_000);
}
