import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCheckpointSession, finalizeCheckpoint, rollbackCheckpoint } from "../checkpoints";
import { canonicalizeWorkspaceRoot } from "../workspace";
import { executeTool } from "./direct";

let fixture: string;
let previousHome: string | undefined;
beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "openhorn-direct-checkpoint-"));
  previousHome = process.env.OPENHORN_HOME;
  process.env.OPENHORN_HOME = path.join(fixture, "snapshots-home");
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.OPENHORN_HOME;
  else process.env.OPENHORN_HOME = previousHome;
  await rm(fixture, { recursive: true, force: true });
});

for (const tool of ["write_file", "edit_file"]) {
  test(`${tool} snapshots an absolute workspace path and restores its original content`, async () => {
    const root = await canonicalizeWorkspaceRoot(fixture);
    const file = path.join(root, "qa.txt");
    await writeFile(file, "original\n");
    const checkpoint = await createCheckpointSession(root);
    const result = await executeTool(
      tool,
      tool === "write_file"
        ? { path: file, content: "changed\n" }
        : { path: file, old_string: "original", new_string: "changed" },
      root,
      { checkpoint },
    );
    expect(result.startsWith("File ")).toBe(true);
    expect(await readFile(file, "utf8")).toBe("changed\n");
    expect(checkpoint.files.size).toBe(1);
    expect([...checkpoint.files.keys()]).toEqual(["qa.txt"]);
    await finalizeCheckpoint(checkpoint);
    await rollbackCheckpoint(root, checkpoint.runId);
    expect(await readFile(file, "utf8")).toBe("original\n");
  });
}
