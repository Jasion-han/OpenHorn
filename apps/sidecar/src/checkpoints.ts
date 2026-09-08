/**
 * Checkpoint snapshots — file-level backup/rollback for agent runs.
 *
 * Runtime state lives under the user's home directory, keyed by a
 * deterministic workspace slug (like Claude Code's ~/.claude/file-history):
 *
 *   ~/.openhorn/snapshots/<workspaceSlug>/<runId>/
 *
 * Nothing is written into the user's project directory. The base path
 * (~/.openhorn) can be overridden via the OPENHORN_HOME env var (tests use
 * this to avoid touching the real home).
 */
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateId } from "./id";
import { ensureParentDirExists, resolvePathInsideWorkspace } from "./workspace";

export type CheckpointFileEntry = {
  path: string;
  existed: boolean;
  backupRelPath?: string;
};

export type CheckpointManifest = {
  runId: string;
  createdAt: string;
  files: CheckpointFileEntry[];
};

export type CheckpointSession = {
  runId: string;
  workspaceRoot: string;
  checkpointDir: string;
  files: Map<string, CheckpointFileEntry>;
};

const MAX_SNAPSHOTS_PER_WORKSPACE = 20;

function normalizeRelPath(input: string) {
  const p = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!p || p === "." || p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) {
    throw new Error("Invalid relative path");
  }
  if (p.startsWith("../") || p.includes("/../") || p.includes("..\\")) {
    throw new Error("Invalid relative path");
  }
  return p;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve the OpenHorn home base (default ~/.openhorn). */
export function resolveSnapshotsHome(): string {
  const base = process.env.OPENHORN_HOME?.trim() || path.join(os.homedir(), ".openhorn");
  return path.join(base, "snapshots");
}

/**
 * Deterministic, filesystem-safe slug from an absolute workspace path.
 * Every `/` and `\` is replaced with `-`; a Windows drive colon is dropped.
 *
 *   /Users/han/Project/Vorla  ->  -Users-han-Project-Vorla
 *   C:\work\x                 ->  C-work-x
 */
export function workspaceSlug(workspaceRoot: string): string {
  // Drop Windows drive colon (C:\... -> C\...)
  let p = workspaceRoot.replace(/^([a-zA-Z]):/, "$1");
  // Replace all separators with -
  p = p.replace(/[\\/]/g, "-");
  return p;
}

/**
 * Full snapshot directory for a given workspace + runId.
 * Validates runId to prevent directory traversal.
 */
export function snapshotDirFor(workspaceRoot: string, runId: string): string {
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) {
    throw new Error(`Invalid runId: ${runId}`);
  }
  return path.join(resolveSnapshotsHome(), workspaceSlug(workspaceRoot), runId);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createCheckpointSession(
  workspaceRoot: string,
  runId: string = generateId(),
): Promise<CheckpointSession> {
  // Best-effort legacy migration + pruning before creating the new session.
  await migrateLegacySnapshots(workspaceRoot);
  await pruneSnapshots(workspaceRoot, MAX_SNAPSHOTS_PER_WORKSPACE);

  const checkpointDir = snapshotDirFor(workspaceRoot, runId);
  await mkdir(path.join(checkpointDir, "files"), { recursive: true });

  return {
    runId,
    workspaceRoot,
    checkpointDir,
    files: new Map(),
  };
}

export async function ensureCheckpointBackup(session: CheckpointSession, targetRelPath: string) {
  const rel = normalizeRelPath(targetRelPath);
  if (session.files.has(rel)) return;

  const resolved = resolvePathInsideWorkspace({
    workspaceRoot: session.workspaceRoot,
    targetPath: rel,
  });
  let existed = false;
  try {
    await stat(resolved);
    existed = true;
  } catch {
    existed = false;
  }

  if (!existed) {
    session.files.set(rel, { path: rel, existed: false });
    return;
  }

  const backupAbs = path.join(session.checkpointDir, "files", rel);
  await ensureParentDirExists(backupAbs);
  const content = await readFile(resolved);
  await writeFile(backupAbs, content);
  session.files.set(rel, {
    path: rel,
    existed: true,
    backupRelPath: path.posix.join("files", rel.replace(/\\/g, "/")),
  });
}

export async function finalizeCheckpoint(session: CheckpointSession): Promise<CheckpointManifest> {
  const manifest: CheckpointManifest = {
    runId: session.runId,
    createdAt: new Date().toISOString(),
    files: Array.from(session.files.values()),
  };
  const manifestPath = path.join(session.checkpointDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export async function rollbackCheckpoint(workspaceRoot: string, runId: string) {
  const checkpointDir = snapshotDirFor(workspaceRoot, runId);
  const manifestPath = path.join(checkpointDir, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as CheckpointManifest;

  for (const file of manifest.files) {
    const rel = normalizeRelPath(file.path);
    const resolved = resolvePathInsideWorkspace({ workspaceRoot, targetPath: rel });
    if (!file.existed) {
      await rm(resolved, { force: true });
      continue;
    }
    const backupAbs = path.join(checkpointDir, "files", rel);
    const content = await readFile(backupAbs);
    await ensureParentDirExists(resolved);
    await writeFile(resolved, content);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Empty snapshot cleanup
// ---------------------------------------------------------------------------

/**
 * Remove a checkpoint session directory if no files were backed up.
 * Called after a run settles so chat-only turns don't leave empty dirs.
 */
export async function discardCheckpointIfEmpty(session: CheckpointSession): Promise<void> {
  try {
    if (session.files.size === 0) {
      await rm(session.checkpointDir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Move snapshot dirs from the old in-project location
 * (<workspaceRoot>/.openhorn/snapshots/<runId>) to the new home-based
 * location. All errors are swallowed — migration must never block a run.
 */
export async function migrateLegacySnapshots(workspaceRoot: string): Promise<void> {
  const legacyBase = path.join(workspaceRoot, ".openhorn", "snapshots");
  try {
    await stat(legacyBase);
  } catch {
    return; // no legacy dir — nothing to do
  }

  try {
    const slug = workspaceSlug(workspaceRoot);
    const newBase = path.join(resolveSnapshotsHome(), slug);
    await mkdir(newBase, { recursive: true });

    const entries = await readdir(legacyBase);
    for (const name of entries) {
      const src = path.join(legacyBase, name);
      const dst = path.join(newBase, name);
      try {
        await stat(dst);
        // target already exists — skip
        continue;
      } catch {
        // target does not exist — proceed
      }
      try {
        await rename(src, dst);
      } catch {
        // rename may fail across devices — fall back to copy + rm
        try {
          await cp(src, dst, { recursive: true });
          await rm(src, { recursive: true, force: true });
        } catch {
          // give up on this entry
        }
      }
    }

    // Clean up the legacy dirs if empty (rmdir fails on non-empty — that's fine)
    try {
      await rmdir(legacyBase);
    } catch {
      // not empty or already gone
    }
    try {
      await rmdir(path.join(workspaceRoot, ".openhorn"));
    } catch {
      // not empty (e.g. skills still there) or already gone
    }
  } catch {
    // swallow everything — migration is best-effort
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Keep only the newest `keep` snapshot dirs per workspace (by mtime).
 * Best-effort — errors are swallowed.
 */
export async function pruneSnapshots(workspaceRoot: string, keep: number): Promise<void> {
  try {
    const slug = workspaceSlug(workspaceRoot);
    const base = path.join(resolveSnapshotsHome(), slug);
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return; // dir doesn't exist yet
    }

    const items: { name: string; mtime: number }[] = [];
    for (const name of entries) {
      try {
        const s = await stat(path.join(base, name));
        items.push({ name, mtime: s.mtimeMs });
      } catch {
        // skip entries we can't stat
      }
    }

    // Sort newest first
    items.sort((a, b) => b.mtime - a.mtime);

    // Remove everything beyond `keep`
    for (const item of items.slice(keep)) {
      try {
        await rm(path.join(base, item.name), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // swallow
  }
}
