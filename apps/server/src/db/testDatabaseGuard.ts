import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class UnsafeTestDatabaseError extends Error {
  readonly code = "unsafe_test_database";

  constructor() {
    super(
      "Refusing to open the default OpenHorn database in test mode. Run Server tests with apps/server/bunfig.toml preload and OPENHORN_TEST_DATABASE_URL, or set DATABASE_URL to an isolated temporary test database before importing db/index.ts.",
    );
    this.name = "UnsafeTestDatabaseError";
  }
}

/** LibSQL permits cwd-relative file: URLs, unlike the standard URL parser. */
function localDatabaseFile(databaseUrl: string, cwd: string): string | null {
  if (databaseUrl === ":memory:") return null;
  if (!/^file:/i.test(databaseUrl)) return null;
  const withoutQuery = databaseUrl.split(/[?#]/, 1)[0] ?? "";
  const rest = withoutQuery.slice("file:".length);
  if (rest === ":memory:") return null;
  if (rest.startsWith("//")) return fileURLToPath(withoutQuery);
  return path.resolve(cwd, decodeURIComponent(rest));
}

/** Resolve existing symlinks even when the database file itself is absent. */
function canonicalFile(file: string, followedLinks = 0): string {
  if (followedLinks > 40) throw new UnsafeTestDatabaseError();
  let ancestor = path.resolve(file);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync.native(ancestor), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      // realpath cannot resolve a dangling symlink. Resolve its textual target
      // before walking missing components, or opening the alias could create
      // the protected database through an otherwise invisible link.
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          const target = path.resolve(path.dirname(ancestor), readlinkSync(ancestor));
          return canonicalFile(path.join(target, ...missing.reverse()), followedLinks + 1);
        }
      } catch (linkError) {
        const linkCode = (linkError as NodeJS.ErrnoException).code;
        if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** This must execute before createClient, not after the first fixture write. */
export function assertIsolatedTestDatabase(
  databaseUrl: string,
  defaultDatabaseFile: string,
  options: { nodeEnv?: string; cwd?: string } = {},
): void {
  if ((options.nodeEnv ?? process.env.NODE_ENV) !== "test") return;
  const selected = localDatabaseFile(databaseUrl, options.cwd ?? process.cwd());
  if (selected === null) return;
  if (canonicalFile(selected) === canonicalFile(defaultDatabaseFile)) {
    throw new UnsafeTestDatabaseError();
  }
  // Different names can still identify the same file through a hard link.
  // Metadata checks never open SQLite or read database contents.
  try {
    const actual = statSync(selected);
    const expected = statSync(defaultDatabaseFile);
    if (actual.dev === expected.dev && actual.ino === expected.ino) {
      throw new UnsafeTestDatabaseError();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}
