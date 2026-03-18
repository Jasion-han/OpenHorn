import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCheckpointSession,
  ensureCheckpointBackup,
  finalizeCheckpoint,
  rollbackCheckpoint,
} from "./checkpoints";
import { canonicalizeWorkspaceRoot } from "./workspace";

describe("checkpoints", () => {
  test("restores modified file", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    writeFileSync(path.join(root, "a.txt"), "v1", "utf8");

    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    await finalizeCheckpoint(session);

    writeFileSync(path.join(root, "a.txt"), "v2", "utf8");
    await rollbackCheckpoint(root, session.runId);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("v1");
  });

  test("removes newly created file", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    mkdirSync(path.join(root, "src"));

    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "src/new.txt");
    await finalizeCheckpoint(session);

    writeFileSync(path.join(root, "src", "new.txt"), "hello", "utf8");
    await rollbackCheckpoint(root, session.runId);
    expect(() => readFileSync(path.join(root, "src", "new.txt"), "utf8")).toThrow();
  });
});
