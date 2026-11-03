import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

for (const scenario of [
  "collision",
  "workspace-failure",
  "project-missing",
  "project-workspace",
  "project-cold",
]) {
  test(`scheduled runner preserves independent ownership and workspace during ${scenario}`, async () => {
    const owned = await mkdtemp(path.join(tmpdir(), "openhorn-scheduled-fixture-"));
    const child = spawn(
      process.execPath,
      [new URL("./backgroundTaskRunner.fixture.ts", import.meta.url).pathname, owned, scenario],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENHORN_HOME: path.join(owned, "snapshots") },
      },
    );
    const text = async (stream: Readable) => {
      let value = "";
      for await (const chunk of stream) value += String(chunk);
      return value;
    };
    const output = text(child.stdout);
    const errors = text(child.stderr);
    try {
      expect((await once(child, "close"))[0]).toBe(0);
      expect(await errors).toBe("");
      const result = JSON.parse(await readFile(path.join(owned, "result.json"), "utf8"));
      expect(result.unknownRequests).toEqual([]);
      if (scenario === "collision") {
        expect(new Set(result.pairs.flat()).size).toBe(4);
        expect(result.saved).toHaveLength(2);
        expect(
          result.saved.map((item: { assistantContent: string }) => item.assistantContent).sort(),
        ).toEqual(["answer-Synthetic prompt 0", "answer-Synthetic prompt 1"]);
        expect(
          result.completed.every((item: { status: string }) => item.status === "completed"),
        ).toBe(true);
        expect(result.agentRoots).toEqual(["/canonical/default", "/canonical/default"]);
      } else if (scenario === "project-workspace" || scenario === "project-cold") {
        expect(result.workspaceRequests).toEqual(["/fixture/project"]);
        expect(result.agentRoots).toEqual(["/canonical/project"]);
        expect(result.completed[0].status).toBe("completed");
        if (scenario === "project-cold") {
          expect(result.projectLoads).toBe(1);
          expect(result.callsBeforeProjects).toBe(0);
        }
      } else {
        expect(result.agentCalls).toBe(0);
        expect(result.completed[0].status).toBe("failed");
        expect(result.saved[0].agentRun.status).toBe("failed");
        if (scenario === "project-missing") expect(result.workspaceRequests).toEqual([]);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
      await Promise.all([output, errors]);
      await rm(owned, { recursive: true, force: true });
    }
  });
}
