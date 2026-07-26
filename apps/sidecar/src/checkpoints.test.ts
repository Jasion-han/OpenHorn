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
import { canonicalizeWorkspaceRoot, toWorkspaceRelative } from "./workspace";

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

  // The Claude SDK's PreToolUse hook reports ABSOLUTE paths. Backing those up
  // is the real production path, so exercise it here — the earlier tests pass
  // relative paths, which is why a total rollback failure went unnoticed.
  test("backs up a file given the absolute path the SDK hook reports", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    writeFileSync(path.join(root, "a.txt"), "v1", "utf8");

    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, toWorkspaceRelative(root, path.join(root, "a.txt")));
    expect(session.files.size).toBe(1);
    await finalizeCheckpoint(session);

    writeFileSync(path.join(root, "a.txt"), "v2", "utf8");
    await rollbackCheckpoint(root, session.runId);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("v1");
  });

  // Guards the failure mode directly: an unconverted absolute path must be
  // rejected, so the conversion at the call site can never quietly regress.
  test("rejects a raw absolute path", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    writeFileSync(path.join(root, "a.txt"), "v1", "utf8");

    const session = await createCheckpointSession(root);
    let threw = false;
    try {
      await ensureCheckpointBackup(session, path.join(root, "a.txt"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(session.files.size).toBe(0);
  });
});
