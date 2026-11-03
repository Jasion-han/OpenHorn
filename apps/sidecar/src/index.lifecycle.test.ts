import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

for (const scenario of [
  "disconnect-agent",
  "disconnect-chat",
  "approval",
  "missing-acp",
  "checkpoint-failure",
  "cancel-checkpoint",
  "disconnect-checkpoint",
]) {
  test(`router releases ownership and prevents work after ${scenario}`, async () => {
    const owned = await mkdtemp(path.join(tmpdir(), "openhorn-router-lifecycle-"));
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./index.lifecycle.fixture.ts", import.meta.url).pathname,
        owned,
        scenario,
      ],
      {
        env: {
          ...process.env,
          TMPDIR: owned,
          OPENHORN_HOME: path.join(owned, "snapshots"),
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
    try {
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
      const result = JSON.parse(await readFile(path.join(owned, "result.json"), "utf8"));
      if (scenario === "cancel-checkpoint")
        expect(result).toEqual({
          runtimeCalls: 0,
          discarded: 1,
          remainingRuns: 0,
          lateCancelAccepted: false,
        });
      else if (scenario === "disconnect-checkpoint")
        expect(result).toEqual({ runtimeCalls: 0, discarded: 1, remainingRuns: 0 });
      else if (scenario.startsWith("disconnect-")) expect(result.runtimeCalls).toBe(0);
      else if (scenario === "approval")
        expect(result).toEqual({ lateApprovalAccepted: false, allowed: false });
      else expect(result).toEqual({ leakedRun: false, doneEvents: 1 });
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
