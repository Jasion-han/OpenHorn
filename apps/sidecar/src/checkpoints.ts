/** File-level run snapshots; legacy locations are read-only compatibility sources. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateId } from "./id";
import { assertIsolatedTestSnapshotHome } from "./testSnapshotGuard";
import { canonicalizeWorkspaceRoot, resolveWritePathInsideWorkspace } from "./workspace";

export type CheckpointFileEntry = {
  path: string;
  existed: boolean;
  backupRelPath?: string;
  mode?: number;
};
export type CheckpointManifest = {
  runId: string;
  createdAt: string;
  /** Required on new snapshots; only physically project-scoped legacy data may omit it. */
  workspaceRoot?: string;
  files: CheckpointFileEntry[];
};
export type CheckpointSession = {
  runId: string;
  workspaceRoot: string;
  checkpointDir: string;
  files: Map<string, CheckpointFileEntry>;
};

const MAX_SNAPSHOTS_PER_WORKSPACE = 20;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILES = 10_000;
// POSIX FIFOs must not block before fstat can reject non-regular files.
const READ_FILE_FLAGS =
  constants.O_RDONLY |
  constants.O_NOFOLLOW |
  (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
const activeCheckpoints = new Set<string>();
const backupTasks = new WeakMap<CheckpointSession, Map<string, Promise<void>>>();

function normalizeRelPath(input: string): string {
  const raw = input.replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("Invalid relative path");
  }
  const parts = raw.split("/");
  if (parts.includes("..")) throw new Error("Invalid relative path");
  const normalized = parts.filter((part) => part !== "" && part !== ".").join("/");
  if (!normalized) throw new Error("Invalid relative path");
  return normalized;
}

export function resolveSnapshotsHome(): string {
  const base = process.env.OPENHORN_HOME?.trim() || path.join(os.homedir(), ".openhorn");
  return path.join(base, "snapshots");
}

function legacyWorkspaceSlug(workspaceRoot: string): string {
  return workspaceRoot.replace(/^([a-zA-Z]):/, "$1").replace(/[\\/]/g, "-");
}

/** Human-readable prefix plus an identity-preserving hash of the canonical root. */
export function workspaceSlug(workspaceRoot: string): string {
  const fingerprint = createHash("sha256").update(workspaceRoot).digest("hex");
  let prefix = "";
  let bytes = 0;
  for (const point of legacyWorkspaceSlug(workspaceRoot)) {
    const width = Buffer.byteLength(point, "utf8");
    if (bytes + width > 96) break;
    prefix += point;
    bytes += width;
  }
  return `${prefix}-${fingerprint}`;
}

function validateRunId(runId: string) {
  if (
    !runId ||
    runId.includes("\0") ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("..")
  ) {
    throw new Error("Invalid checkpoint runId");
  }
}

export function snapshotDirFor(workspaceRoot: string, runId: string): string {
  validateRunId(runId);
  return path.join(resolveSnapshotsHome(), workspaceSlug(workspaceRoot), runId);
}

async function workspaceIdentity(workspaceRoot: string) {
  const canonical = await canonicalizeWorkspaceRoot(workspaceRoot);
  if (canonical !== workspaceRoot || !(await stat(canonical)).isDirectory()) {
    throw new Error("Checkpoint workspace identity changed");
  }
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** Snapshot descendants may not redirect through any symbolic-link component. */
async function snapshotPath(root: string, file: string) {
  if (
    !inside(root, file) ||
    (await realpath(root)) !== root ||
    !(await lstat(root)).isDirectory()
  ) {
    throw new Error("Invalid checkpoint storage path");
  }
  let current = root;
  for (const component of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const item = await lstat(current);
      if (item.isSymbolicLink() || !inside(root, await realpath(current))) {
        throw new Error("Checkpoint storage path contains a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return file;
}

async function workspaceTarget(root: string, relative: string) {
  await workspaceIdentity(root);
  const target = await resolveWritePathInsideWorkspace({
    workspaceRoot: root,
    targetPath: relative,
  });
  try {
    const current = await lstat(target);
    if (current.isSymbolicLink() || !current.isFile())
      throw new Error("Checkpoint target is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

/** Reads a regular terminal file without following a replaced terminal symlink. */
async function readChecked(file: string, validate: () => Promise<unknown>, limit?: number) {
  await validate();
  const handle = await open(file, READ_FILE_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Checkpoint source is not a regular file");
    await validate();
    const current = await lstat(file);
    if (opened.ino !== current.ino || opened.dev !== current.dev)
      throw new Error("Checkpoint source changed");
    let content: Buffer;
    if (limit === undefined) content = await handle.readFile();
    else {
      if (opened.size > limit) throw new Error("Checkpoint manifest is too large");
      const bytes = Buffer.alloc(Math.min(limit + 1, opened.size + 1));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error("Checkpoint manifest is too large");
      if (length > opened.size) throw new Error("Checkpoint source changed");
      content = bytes.subarray(0, length);
    }
    await validate();
    const latest = await lstat(file);
    if (opened.ino !== latest.ino || opened.dev !== latest.dev)
      throw new Error("Checkpoint source changed");
    return content;
  } finally {
    await handle.close();
  }
}

/** Atomic leaf replacement avoids truncating an outside inode through a hardlink. */
async function replaceChecked(
  file: string,
  content: Uint8Array,
  validate: (candidate: string) => Promise<unknown>,
  mustBeNew = false,
  mode = 0o600,
) {
  await validate(file);
  await mkdir(path.dirname(file), { recursive: true });
  await validate(file);
  const temporary = path.join(path.dirname(file), `.openhorn-checkpoint-${randomUUID()}.tmp`);
  await validate(temporary);
  let created = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await validate(temporary);
    await validate(file);
    if (mustBeNew) {
      try {
        await lstat(file);
        throw new Error("Checkpoint backup already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, file);
    created = false;
  } finally {
    if (created) {
      try {
        await validate(temporary);
        await rm(temporary, { force: true });
      } catch {
        /* retain uncertain paths */
      }
    }
  }
}

async function newStorageRoot() {
  const home = resolveSnapshotsHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  return realpath(home);
}

export async function createCheckpointSession(
  workspaceRoot: string,
  runId: string = generateId(),
): Promise<CheckpointSession> {
  assertIsolatedTestSnapshotHome();
  validateRunId(runId);
  const canonical = await canonicalizeWorkspaceRoot(workspaceRoot);
  await workspaceIdentity(canonical);
  const home = await newStorageRoot();
  const bucket = path.join(home, workspaceSlug(canonical));
  await snapshotPath(home, bucket);
  await mkdir(bucket, { recursive: true, mode: 0o700 });
  await snapshotPath(home, bucket);
  await pruneSnapshots(canonical, MAX_SNAPSHOTS_PER_WORKSPACE);
  const checkpointDir = path.join(bucket, runId);
  await snapshotPath(home, checkpointDir);
  await mkdir(checkpointDir, { mode: 0o700 });
  await mkdir(path.join(checkpointDir, "files"), { mode: 0o700 });
  await snapshotPath(home, path.join(checkpointDir, "files"));
  activeCheckpoints.add(checkpointDir);
  return { runId, workspaceRoot: canonical, checkpointDir, files: new Map() };
}

async function sessionStorage(session: CheckpointSession) {
  await workspaceIdentity(session.workspaceRoot);
  const home = await realpath(resolveSnapshotsHome());
  const expected = path.join(home, workspaceSlug(session.workspaceRoot), session.runId);
  if (expected !== session.checkpointDir)
    throw new Error("Checkpoint session storage identity changed");
  await snapshotPath(home, session.checkpointDir);
  return home;
}

export async function ensureCheckpointBackup(session: CheckpointSession, targetRelPath: string) {
  assertIsolatedTestSnapshotHome();
  const relative = normalizeRelPath(targetRelPath);
  if (session.files.has(relative)) return;
  let tasks = backupTasks.get(session);
  if (!tasks) {
    tasks = new Map();
    backupTasks.set(session, tasks);
  }
  const existing = tasks.get(relative);
  if (existing) return existing;
  const pending = (async () => {
    const home = await sessionStorage(session);
    const target = await workspaceTarget(session.workspaceRoot, relative);
    let mode: number;
    try {
      mode = (await lstat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await workspaceTarget(session.workspaceRoot, relative);
      session.files.set(relative, { path: relative, existed: false });
      return;
    }
    const content = await readChecked(target, () =>
      workspaceTarget(session.workspaceRoot, relative),
    );
    const backup = path.join(session.checkpointDir, "files", relative);
    await replaceChecked(backup, content, (candidate) => snapshotPath(home, candidate), true);
    session.files.set(relative, {
      path: relative,
      existed: true,
      backupRelPath: path.posix.join("files", relative),
      mode,
    });
  })();
  tasks.set(relative, pending);
  try {
    await pending;
  } finally {
    if (tasks.get(relative) === pending) tasks.delete(relative);
  }
}

export async function finalizeCheckpoint(session: CheckpointSession): Promise<CheckpointManifest> {
  assertIsolatedTestSnapshotHome();
  const tasks = backupTasks.get(session);
  if (tasks) await Promise.all(tasks.values());
  const home = await sessionStorage(session);
  const manifest: CheckpointManifest = {
    runId: session.runId,
    workspaceRoot: session.workspaceRoot,
    createdAt: new Date().toISOString(),
    files: [...session.files.values()],
  };
  await replaceChecked(
    path.join(session.checkpointDir, "manifest.json"),
    Buffer.from(JSON.stringify(manifest, null, 2)),
    (candidate) => snapshotPath(home, candidate),
  );
  activeCheckpoints.delete(session.checkpointDir);
  return manifest;
}

function parseManifest(
  raw: Buffer,
  workspaceRoot: string,
  runId: string,
  projectLegacy: boolean,
): CheckpointManifest {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid checkpoint manifest");
  const item = value as Record<string, unknown>;
  if (
    item.runId !== runId ||
    typeof item.createdAt !== "string" ||
    !Array.isArray(item.files) ||
    item.files.length > MAX_MANIFEST_FILES
  )
    throw new Error("Invalid checkpoint manifest");
  if (item.workspaceRoot !== workspaceRoot && !(projectLegacy && item.workspaceRoot === undefined))
    throw new Error("Checkpoint workspace identity is missing or mismatched");
  const seen = new Set<string>();
  const files = item.files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid checkpoint entry");
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.existed !== "boolean")
      throw new Error("Invalid checkpoint entry");
    const relative = normalizeRelPath(file.path);
    if (
      file.mode !== undefined &&
      (typeof file.mode !== "number" ||
        !Number.isInteger(file.mode) ||
        file.mode < 0 ||
        file.mode > 0o777 ||
        !file.existed)
    )
      throw new Error("Invalid checkpoint permission mode");
    const backupRelPath = path.posix.join("files", relative);
    if (
      seen.has(relative) ||
      (file.backupRelPath !== undefined && file.backupRelPath !== backupRelPath) ||
      (!file.existed && file.backupRelPath !== undefined)
    )
      throw new Error("Invalid checkpoint backup path");
    seen.add(relative);
    return {
      path: relative,
      existed: file.existed,
      ...(file.existed ? { backupRelPath } : {}),
      // Rootless project legacy snapshots did not record permissions reliably.
      ...(item.workspaceRoot === workspaceRoot && file.mode !== undefined
        ? { mode: file.mode as number }
        : {}),
    };
  });
  return { runId, workspaceRoot, createdAt: item.createdAt, files };
}

async function locateManifest(workspaceRoot: string, runId: string) {
  await workspaceIdentity(workspaceRoot);
  let home: string | null = null;
  try {
    home = await realpath(resolveSnapshotsHome());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidates = [
    ...(home
      ? [
          {
            base: home,
            dir: path.join(home, workspaceSlug(workspaceRoot), runId),
            projectLegacy: false,
          },
        ]
      : []),
    {
      base: workspaceRoot,
      dir: path.join(workspaceRoot, ".openhorn", "snapshots", runId),
      projectLegacy: true,
    },
    ...(home
      ? [
          {
            base: home,
            dir: path.join(home, legacyWorkspaceSlug(workspaceRoot), runId),
            projectLegacy: false,
          },
        ]
      : []),
  ];
  for (const candidate of candidates) {
    const file = path.join(candidate.dir, "manifest.json");
    let raw: Buffer;
    try {
      raw = await readChecked(file, () => snapshotPath(candidate.base, file), MAX_MANIFEST_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    return {
      ...candidate,
      manifest: parseManifest(raw, workspaceRoot, runId, candidate.projectLegacy),
    };
  }
  throw new Error("Checkpoint not found");
}

export async function rollbackCheckpoint(workspaceRoot: string, runId: string) {
  assertIsolatedTestSnapshotHome();
  validateRunId(runId);
  const located = await locateManifest(workspaceRoot, runId);
  // Validate every target and readable backup before changing the first file.
  for (const file of located.manifest.files) {
    await workspaceTarget(workspaceRoot, file.path);
    if (file.existed) {
      const backup = path.join(located.dir, "files", file.path);
      await snapshotPath(located.base, backup);
      const handle = await open(backup, READ_FILE_FLAGS);
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Invalid checkpoint backup");
      } finally {
        await handle.close();
      }
    }
  }
  for (const file of located.manifest.files) {
    const target = await workspaceTarget(workspaceRoot, file.path);
    if (!file.existed) {
      await rm(target, { force: true });
      continue;
    }
    const backup = path.join(located.dir, "files", file.path);
    const content = await readChecked(backup, () => snapshotPath(located.base, backup));
    let mode = file.mode ?? 0o600 & ~process.umask();
    try {
      mode = (await lstat(target)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await replaceChecked(
      target,
      content,
      (candidate) => workspaceTarget(workspaceRoot, path.relative(workspaceRoot, candidate)),
      false,
      mode,
    );
  }
  return { ok: true };
}

export async function discardCheckpointIfEmpty(session: CheckpointSession): Promise<void> {
  assertIsolatedTestSnapshotHome();
  activeCheckpoints.delete(session.checkpointDir);
  try {
    if (session.files.size === 0) {
      const home = await sessionStorage(session);
      await snapshotPath(home, session.checkpointDir);
      await rm(session.checkpointDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort cleanup cannot replace a run's outcome */
  }
}

/** Prune only this root's positively identified, completed hashed snapshots. */
export async function pruneSnapshots(workspaceRoot: string, keep: number): Promise<void> {
  assertIsolatedTestSnapshotHome();
  try {
    await workspaceIdentity(workspaceRoot);
    const home = await realpath(resolveSnapshotsHome());
    const base = path.join(home, workspaceSlug(workspaceRoot));
    await snapshotPath(home, base);
    const items: Array<{ dir: string; mtime: number }> = [];
    for (const name of await readdir(base)) {
      try {
        validateRunId(name);
        const dir = path.join(base, name);
        if (activeCheckpoints.has(dir)) continue;
        await snapshotPath(home, dir);
        if (!(await lstat(dir)).isDirectory()) continue;
        const manifestFile = path.join(dir, "manifest.json");
        const raw = await readChecked(
          manifestFile,
          () => snapshotPath(home, manifestFile),
          MAX_MANIFEST_BYTES,
        );
        parseManifest(raw, workspaceRoot, name, false);
        items.push({ dir, mtime: (await stat(dir)).mtimeMs });
      } catch {
        /* preserve incomplete, malformed and unowned entries */
      }
    }
    items.sort((a, b) => b.mtime - a.mtime);
    for (const item of items.slice(Math.max(0, Math.floor(keep)))) {
      try {
        await snapshotPath(home, item.dir);
        await rm(item.dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort; never touch legacy buckets */
  }
}
