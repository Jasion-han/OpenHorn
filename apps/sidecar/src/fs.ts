import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertExistingPathInsideWorkspace,
  ensureParentDirExists,
  resolvePathInsideWorkspace,
} from "./workspace";

export type FsEntry = {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  mtimeMs?: number;
};

function shouldHideName(name: string) {
  return name === ".openhorn";
}

export async function fsList(input: {
  workspaceRoot: string;
  dir: string;
}): Promise<{ entries: FsEntry[] }> {
  const resolvedDir = resolvePathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    targetPath: input.dir,
  });
  await assertExistingPathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    resolvedPath: resolvedDir,
  });

  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const results: FsEntry[] = [];

  for (const entry of entries) {
    if (shouldHideName(entry.name)) continue;
    const kind: FsEntry["kind"] = entry.isDirectory() ? "dir" : "file";
    const full = path.join(resolvedDir, entry.name);

    let s: { size: number; mtimeMs: number } | null = null;
    try {
      const st = await stat(full);
      s = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      // ignore
    }

    results.push({
      name: entry.name,
      path: path.relative(input.workspaceRoot, full),
      kind,
      size: s?.size,
      mtimeMs: s?.mtimeMs,
    });
  }

  results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { entries: results };
}

export async function fsReadText(input: {
  workspaceRoot: string;
  filePath: string;
}): Promise<{ content: string }> {
  const resolved = resolvePathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    targetPath: input.filePath,
  });
  await assertExistingPathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    resolvedPath: resolved,
  });
  const content = await readFile(resolved, "utf8");
  return { content };
}

export async function fsWriteText(input: {
  workspaceRoot: string;
  filePath: string;
  content: string;
}): Promise<{ ok: true }> {
  const resolved = resolvePathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    targetPath: input.filePath,
  });
  await ensureParentDirExists(resolved);
  await writeFile(resolved, input.content, "utf8");
  return { ok: true };
}
