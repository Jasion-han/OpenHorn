import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCheckpointSession,
  discardCheckpointIfEmpty,
  ensureCheckpointBackup,
  finalizeCheckpoint,
  pruneSnapshots,
  rollbackCheckpoint,
  snapshotDirFor,
  workspaceSlug,
} from "./checkpoints";
import { canonicalizeWorkspaceRoot, toWorkspaceRelative } from "./workspace";

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.OPENHORN_HOME;
  process.env.OPENHORN_HOME = mkdtempSync(path.join(os.tmpdir(), "openhorn-home-"));
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.OPENHORN_HOME;
  } else {
    process.env.OPENHORN_HOME = savedHome;
  }
});

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

describe("workspaceSlug", () => {
  test("posix path", () => {
    expect(workspaceSlug("/Users/han/Project/Vorla")).toBe("-Users-han-Project-Vorla");
  });

  test("windows path", () => {
    expect(workspaceSlug("C:\\work\\x")).toBe("C-work-x");
  });
});

describe("snapshot location", () => {
  test("creates snapshot under OPENHORN_HOME, not under workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );

    const session = await createCheckpointSession(root);

    // Snapshot dir must be under OPENHORN_HOME
    const home = process.env.OPENHORN_HOME as string;
    expect(session.checkpointDir.startsWith(home)).toBe(true);

    // Nothing must be created under <workspace>/.openhorn/snapshots
    expect(existsSync(path.join(root, ".openhorn", "snapshots"))).toBe(false);
  });

  test("does not touch .gitignore in a git workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    await createCheckpointSession(root);

    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });
});

describe("discardCheckpointIfEmpty", () => {
  test("removes session dir with no backups", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    const session = await createCheckpointSession(root);
    // No files backed up
    await discardCheckpointIfEmpty(session);
    expect(existsSync(session.checkpointDir)).toBe(false);
  });

  test("keeps session dir with a backup", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    writeFileSync(path.join(root, "a.txt"), "v1", "utf8");
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    await discardCheckpointIfEmpty(session);
    expect(existsSync(session.checkpointDir)).toBe(true);
  });
});

describe("pruneSnapshots", () => {
  test("keeps the newest N and removes older ones", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    const home = process.env.OPENHORN_HOME as string;
    const slug = workspaceSlug(root);
    const base = path.join(home, "snapshots", slug);
    mkdirSync(base, { recursive: true });

    // Create 23 dirs with staggered mtimes
    const now = Date.now();
    const names: string[] = [];
    for (let i = 0; i < 23; i++) {
      const name = `run-${String(i).padStart(3, "0")}`;
      names.push(name);
      const dir = path.join(base, name);
      mkdirSync(dir);
      // Older dirs get earlier mtime
      const t = new Date(now - (22 - i) * 60_000);
      await utimes(dir, t, t);
    }

    await pruneSnapshots(root, 20);

    const remaining = readdirSync(base).sort();
    expect(remaining).toHaveLength(20);
    // The 3 oldest (run-000, run-001, run-002) should be gone
    expect(remaining.includes("run-000")).toBe(false);
    expect(remaining.includes("run-001")).toBe(false);
    expect(remaining.includes("run-002")).toBe(false);
    // The newest should still exist
    expect(remaining.includes("run-022")).toBe(true);
  });
});

describe("legacy migration", () => {
  test("migrates legacy snapshots and rollback works from new location", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );

    // Pre-create legacy snapshot structure
    const legacyDir = path.join(root, ".openhorn", "snapshots", "claude-1");
    mkdirSync(path.join(legacyDir, "files"), { recursive: true });
    writeFileSync(
      path.join(legacyDir, "manifest.json"),
      JSON.stringify({
        runId: "claude-1",
        createdAt: new Date().toISOString(),
        files: [{ path: "a.txt", existed: true, backupRelPath: "files/a.txt" }],
      }),
      "utf8",
    );
    writeFileSync(path.join(legacyDir, "files", "a.txt"), "backup-v1", "utf8");

    // Current file in workspace
    writeFileSync(path.join(root, "a.txt"), "v2", "utf8");

    // createCheckpointSession triggers migration
    await createCheckpointSession(root);

    // Legacy dir should be gone (or .openhorn itself if empty)
    expect(existsSync(path.join(root, ".openhorn", "snapshots"))).toBe(false);

    // Manifest should exist at new location
    const home = process.env.OPENHORN_HOME as string;
    const slug = workspaceSlug(root);
    const newManifest = path.join(home, "snapshots", slug, "claude-1", "manifest.json");
    expect(existsSync(newManifest)).toBe(true);

    // Rollback should restore the file from the migrated backup
    await rollbackCheckpoint(root, "claude-1");
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("backup-v1");
  });
});

describe("snapshotDirFor", () => {
  test("rejects runId containing ..", () => {
    let threw = false;
    try {
      snapshotDirFor("/tmp/ws", "../../etc");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("rejects runId containing /", () => {
    let threw = false;
    try {
      snapshotDirFor("/tmp/ws", "foo/bar");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("rejects runId containing backslash", () => {
    let threw = false;
    try {
      snapshotDirFor("/tmp/ws", "foo\\bar");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
