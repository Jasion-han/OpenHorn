import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

for (const scenario of ["different", "collision"]) {
  test(`checkpoint RPC retains the run workspace after selecting a ${scenario} root`, async () => {
    const owned = await mkdtemp(path.join(tmpdir(), "openhorn-checkpoint-router-"));
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./index.checkpoint.fixture.ts", import.meta.url).pathname,
        owned,
        scenario,
      ],
      {
        env: {
          ...process.env,
          OPENHORN_HOME: path.join(owned, "state"),
          TMPDIR: owned,
          OPENHORN_HOST: "127.0.0.1",
          OPENHORN_PORT: "0",
          OPENHORN_HANDSHAKE_TOKEN: crypto.randomUUID(),
          OPENHORN_PARENT_WATCH: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Checkpoint router timed out")), 8000);
        }),
      ]);
      expect(code).toBe(0);
      expect(await errors).toBe("");
      expect(JSON.parse((await out).trim())).toEqual({
        rollbackOk: true,
        a: "A-original",
        b: "B-original",
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await Promise.all([out, errors]);
      await rm(owned, { recursive: true, force: true });
    }
  }, 10_000);
}
