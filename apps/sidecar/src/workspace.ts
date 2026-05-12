import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function ensureNoNullBytes(input: string) {
  if (input.includes("\0")) {
    throw new Error("Invalid path");
  }
}

/**
 * Builds the per-OS list of paths that are NEVER acceptable as a sidecar
 * workspace root. This is intentionally a deny-list (the user picks the
 * workspace through a Tauri dialog so the input itself is trusted), but
 * we still refuse a few obviously dangerous targets.
 *
 * Exported so tests can confirm coverage of the standard suspects.
 */
export function getForbiddenWorkspaceRoots(homeDirOverride?: string): string[] {
  const home = homeDirOverride ?? os.homedir();
  const homeChildren = (children: string[]) => children.map((child) => path.join(home, child));
  return [
    "/",
    "/bin",
    "/sbin",
    "/etc",
    "/usr",
    "/var",
    "/tmp",
    "/dev",
    "/private",
    "/private/etc",
    "/private/var",
    "/private/tmp",
    "/System",
    "/Library",
    "/opt",
    "/root",
    "/boot",
    "/proc",
    "/sys",
    "C:\\",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    home,
    ...homeChildren([
      ".ssh",
      ".aws",
      ".gnupg",
      ".config",
      ".kube",
      ".docker",
      "Library",
      "Library/Keychains",
      "Library/Application Support",
      "Desktop",
      "Documents",
      "Pictures",
      "Music",
      "Movies",
      "AppData",
    ]),
  ];
}

export class ForbiddenWorkspaceRootError extends Error {
  constructor(root: string) {
    super(`Workspace root is not allowed: ${root}`);
    this.name = "ForbiddenWorkspaceRootError";
  }
}

export async function canonicalizeWorkspaceRoot(root: string): Promise<string> {
  ensureNoNullBytes(root);
  const real = await realpath(root);

  const forbidden = getForbiddenWorkspaceRoots();
  for (const denied of forbidden) {
    if (real === denied) {
      throw new ForbiddenWorkspaceRootError(real);
    }
  }
  return real;
}

function rootWithTrailingSep(workspaceRoot: string): string {
  return workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
}

function isInside(workspaceRoot: string, candidate: string): boolean {
  return candidate === workspaceRoot || candidate.startsWith(rootWithTrailingSep(workspaceRoot));
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
  if (!isInside(input.workspaceRoot, resolved)) {
    throw new Error("Path escapes workspace");
  }

  return resolved;
}

export async function assertExistingPathInsideWorkspace(input: {
  workspaceRoot: string;
  resolvedPath: string;
}): Promise<void> {
  const rp = await realpath(input.resolvedPath);
  if (!isInside(input.workspaceRoot, rp)) {
    throw new Error("Path escapes workspace");
  }
}

/**
 * Resolves a workspace-relative target for a *write* operation.
 *
 * Unlike `assertExistingPathInsideWorkspace` (which only works on paths
 * that already exist), write operations must also be safe when the target
 * file is brand new. To prevent symlink-based escapes we:
 *
 *   1. Reject absolute paths and `..` traversal at the lexical level
 *      (via resolvePathInsideWorkspace).
 *   2. realpath the deepest existing ancestor of the target. The result
 *      must still be inside the workspace, otherwise some component of
 *      the path is a symlink that points outside.
 *   3. If the target itself already exists, realpath it directly — this
 *      catches the "symlink file inside workspace pointing at an outside
 *      file" case.
 *
 * Returns the lexically-resolved (not symlink-followed) path that the
 * caller should pass to `writeFile`. We deliberately do not return the
 * realpath, because some callers want to keep the write inside the
 * workspace tree even if a non-escaping symlink is involved — but the
 * checks above guarantee no symlink leaves the workspace.
 */
export async function resolveWritePathInsideWorkspace(input: {
  workspaceRoot: string;
  targetPath: string;
}): Promise<string> {
  const lexical = resolvePathInsideWorkspace({
    workspaceRoot: input.workspaceRoot,
    targetPath: input.targetPath,
  });

  // Case 1: target already exists. realpath the target itself.
  try {
    const targetStat = await stat(lexical);
    if (targetStat) {
      const realTarget = await realpath(lexical);
      if (!isInside(input.workspaceRoot, realTarget)) {
        throw new Error("Path escapes workspace");
      }
      return lexical;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    // fall through to ancestor check
  }

  // Case 2: target does not exist. Walk up until we find an ancestor that
  // does, realpath it, and confirm it's still inside the workspace. This
  // catches symlinked parent directories that point outside.
  let ancestor = path.dirname(lexical);
  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      if (!isInside(input.workspaceRoot, realAncestor)) {
        throw new Error("Path escapes workspace");
      }
      return lexical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
      const next = path.dirname(ancestor);
      if (next === ancestor) {
        // Walked all the way up without finding an existing ancestor.
        // That should never happen given lexical is inside workspaceRoot
        // and workspaceRoot itself exists.
        throw new Error("Unable to resolve ancestor");
      }
      ancestor = next;
    }
  }
}

export async function ensureParentDirExists(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
}
