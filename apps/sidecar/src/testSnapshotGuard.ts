import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class UnsafeTestSnapshotHomeError extends Error {
  readonly code = "unsafe_test_snapshot_home";

  constructor() {
    super(
      "Refusing checkpoint IO in test mode without an isolated OPENHORN_HOME. Set it to an owned temporary test directory before using checkpoint operations.",
    );
    this.name = "UnsafeTestSnapshotHomeError";
  }
}

/** Resolve aliases even when the final directory or a symlink target is absent. */
function canonicalFolder(folder: string, followedLinks = 0): string {
  if (followedLinks > 40) throw new UnsafeTestSnapshotHomeError();
  let ancestor = path.resolve(folder);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync.native(ancestor), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          const target = path.resolve(path.dirname(ancestor), readlinkSync(ancestor));
          return canonicalFolder(path.join(target, ...missing.reverse()), followedLinks + 1);
        }
      } catch (linkError) {
        const code = (linkError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function containsDirectory(folder: string, expected: string) {
  let identity: ReturnType<typeof statSync>;
  try {
    identity = statSync(expected);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  let candidate = folder;
  while (true) {
    try {
      const current = statSync(candidate);
      if (current.dev === identity.dev && current.ino === identity.ino) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

/** Second boundary: package cwd/preloads cannot authorize the normal state tree. */
export function assertIsolatedTestSnapshotHome(
  options: { nodeEnv?: string; configuredHome?: string; defaultHome?: string; cwd?: string } = {},
): void {
  if ((options.nodeEnv ?? process.env.NODE_ENV) !== "test") return;
  const configured = (
    Object.hasOwn(options, "configuredHome") ? options.configuredHome : process.env.OPENHORN_HOME
  )?.trim();
  if (!configured || configured.includes("\0")) throw new UnsafeTestSnapshotHomeError();
  try {
    const selectedHome = path.resolve(options.cwd ?? process.cwd(), configured);
    const defaultHome = options.defaultHome ?? path.join(os.homedir(), ".openhorn");
    // The selected home's snapshots child can redirect independently of its
    // parent; the normal home's actual snapshots child can do the same.
    const selectedPaths = [selectedHome, path.join(selectedHome, "snapshots")].map((value) =>
      canonicalFolder(value),
    );
    const protectedPaths = [defaultHome, path.join(defaultHome, "snapshots")].map((value) =>
      canonicalFolder(value),
    );
    for (const selected of selectedPaths) {
      for (const protectedHome of protectedPaths) {
        if (
          within(protectedHome, selected) ||
          within(selected, protectedHome) ||
          containsDirectory(selected, protectedHome) ||
          containsDirectory(protectedHome, selected)
        )
          throw new UnsafeTestSnapshotHomeError();
      }
    }
  } catch {
    throw new UnsafeTestSnapshotHomeError();
  }
}
