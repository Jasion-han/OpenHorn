import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("agent.run owns its validated workspace after a stopped setup RPC finishes late", async () => {
  const owned = await mkdtemp(path.join(tmpdir(), "openhorn-workspace-router-"));
  const child = Bun.spawn(
    [process.execPath, new URL("./index.workspace.fixture.ts", import.meta.url).pathname, owned],
    {
      env: {
        ...process.env,
        TMPDIR: owned,
        OPENHORN_HOME: path.join(owned, "snapshots-home"),
        OPENHORN_HOST: "127.0.0.1",
        OPENHORN_PORT: "0",
        OPENHORN_HANDSHAKE_TOKEN: crypto.randomUUID(),
        OPENHORN_PARENT_WATCH: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned router timed out")), 10_000);
      }),
    ]);
    expect(await errors).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse((await output).trim())).toEqual({
      defaultWorkspaceResolved: true,
      defaultRunUsesResolvedRoot: true,
      rejectedWorkspaceParams: 6,
      invalidWorkspaceParamsStartedNoRuns: true,
      selectedB: true,
      explicitRuntimes: ["codex", "direct", "acp"],
      explicitRootsAreB: true,
      rejectedRoots: 7,
      invalidRootsStartedNoRuns: true,
      legacyOmittedRootIsCurrentA: true,
      canonicalAliasResolved: true,
      oldPreparationStartedNoRun: true,
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.all([output, errors]);
    await rm(owned, { recursive: true, force: true });
  }
}, 15_000);
