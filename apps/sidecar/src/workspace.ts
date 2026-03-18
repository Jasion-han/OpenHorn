import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function ensureNoNullBytes(input: string) {
  if (input.includes("\0")) {
    throw new Error("Invalid path");
  }
}

export async function canonicalizeWorkspaceRoot(root: string): Promise<string> {
  ensureNoNullBytes(root);
  return realpath(root);
}

export function resolvePathInsideWorkspace(input: {
  workspaceRoot: string;
  targetPath: string;
}): string {
  ensureNoNullBytes(input.targetPath);

  if (path.isAbsolute(input.targetPath)) {
    throw new Error("Path must be workspace-relative");
  }

  const resolved = path.resolve(input.workspaceRoot, input.targetPath);
  const rootWithSep = input.workspaceRoot.endsWith(path.sep)
    ? input.workspaceRoot
    : `${input.workspaceRoot}${path.sep}`;
  if (resolved !== input.workspaceRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path escapes workspace");
  }

  return resolved;
}

export async function assertExistingPathInsideWorkspace(input: {
  workspaceRoot: string;
  resolvedPath: string;
}): Promise<void> {
  const rp = await realpath(input.resolvedPath);
  const rootWithSep = input.workspaceRoot.endsWith(path.sep)
    ? input.workspaceRoot
    : `${input.workspaceRoot}${path.sep}`;
  if (rp !== input.workspaceRoot && !rp.startsWith(rootWithSep)) {
    throw new Error("Path escapes workspace");
  }
}

export async function ensureParentDirExists(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
}
