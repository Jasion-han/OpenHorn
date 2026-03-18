import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

export async function createCheckpointSession(workspaceRoot: string): Promise<CheckpointSession> {
  const runId = generateId();
  const checkpointDir = path.join(workspaceRoot, ".openhorn", "snapshots", runId);
  await mkdir(path.join(checkpointDir, "files"), { recursive: true });
  await ensureGitignore(workspaceRoot);

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
  const checkpointDir = path.join(workspaceRoot, ".openhorn", "snapshots", runId);
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

async function ensureGitignore(workspaceRoot: string) {
  try {
    await stat(path.join(workspaceRoot, ".git"));
  } catch {
    return;
  }

  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }

  if (current.split(/\r?\n/).some((line) => line.trim() === ".openhorn/")) {
    return;
  }

  const next = `${current.trimEnd()}${current.trim().length ? "\n" : ""}.openhorn/\n`;
  await writeFile(gitignorePath, next, "utf8");
}
