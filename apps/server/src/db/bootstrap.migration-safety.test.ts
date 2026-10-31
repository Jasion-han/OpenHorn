import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bootstrapDatabase,
  createMigrationBackup,
  type MigrationBackupTarget,
  resolveMigrationBackupTarget,
  runOneTimeMigrations,
} from "./bootstrap";
import { client } from "./index";

// Everything here runs against the shared test database (see test-setup.ts).
// Each test puts back what it changes: the schema_migrations rows and the
// users table layout.

let scratch: string;
let recorded: Array<{ id: string; appliedAt: number }> = [];

beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "openhorn-migration-safety-"));
  const rows = (await client.execute("SELECT id, applied_at FROM schema_migrations;")).rows;
  recorded = rows.map((row) => ({ id: String(row.id), appliedAt: Number(row.applied_at) }));
});

async function restoreMigrationRecords() {
  await client.execute("DELETE FROM schema_migrations;");
  for (const row of recorded) {
    await client.execute({
      sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?);",
      args: [row.id, row.appliedAt],
    });
  }
}

afterAll(async () => {
  await restoreMigrationRecords();
  rmSync(scratch, { recursive: true, force: true });
});

function targetIn(name: string, keep = 5): MigrationBackupTarget {
  return {
    databasePath: path.join(scratch, "openhorn.db"),
    directory: path.join(scratch, name),
    keep,
  };
}

function backupsIn(target: MigrationBackupTarget): string[] {
  try {
    return readdirSync(target.directory).filter((name) => name.startsWith("openhorn-"));
  } catch {
    return [];
  }
}

async function recordedIds(): Promise<string[]> {
  const rows = (await client.execute("SELECT id FROM schema_migrations ORDER BY id;")).rows;
  return rows.map((row) => String(row.id));
}

describe("resolveMigrationBackupTarget", () => {
  test("file database → <db dir>/backups", () => {
    expect(resolveMigrationBackupTarget("file:/srv/data/openhorn.db")).toEqual({
      databasePath: "/srv/data/openhorn.db",
      directory: "/srv/data/backups",
      keep: 5,
    });
    expect(resolveMigrationBackupTarget("file:///srv/data/openhorn.db?mode=rwc")?.directory).toBe(
      "/srv/data/backups",
    );
    expect(resolveMigrationBackupTarget("file:./data/openhorn.db")?.databasePath).toBe(
      path.resolve("data/openhorn.db"),
    );
  });

  test("in-memory and remote databases are not backed up", () => {
    expect(resolveMigrationBackupTarget(":memory:")).toBeNull();
    expect(resolveMigrationBackupTarget("file::memory:")).toBeNull();
    expect(resolveMigrationBackupTarget("libsql://example.turso.io")).toBeNull();
    expect(resolveMigrationBackupTarget(undefined)).toBeNull();
  });
});

describe("createMigrationBackup", () => {
  test("writes a readable snapshot and keeps only the newest `keep`", async () => {
    const target = targetIn("rotation", 2);
    // Not a snapshot of this database: never pruned.
    const unrelated = path.join(target.directory, "openhorn-notes.txt");
    const files: string[] = [];
    for (let i = 0; i < 3; i++) {
      files.push(await createMigrationBackup(target, "test"));
      if (i === 0) writeFileSync(unrelated, "keep me");
      await Bun.sleep(2); // distinct millisecond timestamps
    }
    const left = backupsIn(target).sort();
    expect(left).toEqual(
      [path.basename(files[1] ?? ""), path.basename(files[2] ?? ""), "openhorn-notes.txt"].sort(),
    );

    const { createClient } = await import("@libsql/client");
    const snapshot = createClient({ url: `file:${files[2]}` });
    const result = await snapshot.execute("SELECT COUNT(*) AS n FROM schema_migrations;");
    expect(Number(result.rows[0]?.n)).toBe(recorded.length);
    snapshot.close();
  });

  test("throws when the snapshot cannot be written", async () => {
    const blocker = path.join(scratch, "not-a-directory");
    writeFileSync(blocker, "");
    const target = { ...targetIn("unused"), directory: blocker };
    await expect(createMigrationBackup(target, "test")).rejects.toThrow(/refusing to migrate/);
  });
});

describe("one-time migrations and backups", () => {
  test("pending migrations are backed up first, then recorded", async () => {
    const target = targetIn("pending");
    await client.execute(
      "DELETE FROM schema_migrations WHERE id = 'backfill-agent-reply-content';",
    );
    await runOneTimeMigrations(target);
    expect(backupsIn(target)).toHaveLength(1);
    expect(await recordedIds()).toContain("backfill-agent-reply-content");
    await restoreMigrationRecords();
  });

  test("nothing pending: no backup", async () => {
    const target = targetIn("nothing-pending");
    await runOneTimeMigrations(target);
    expect(backupsIn(target)).toHaveLength(0);
    // A full bootstrap of an up-to-date database copies nothing either.
    await bootstrapDatabase({ backup: target });
    expect(backupsIn(target)).toHaveLength(0);
  });

  test("a failed backup blocks the migrations", async () => {
    const blocker = path.join(scratch, "blocker");
    writeFileSync(blocker, "");
    await client.execute("DELETE FROM schema_migrations;");
    await client.execute("PRAGMA user_version = 0;");
    await expect(
      runOneTimeMigrations({ ...targetIn("unused"), directory: blocker }),
    ).rejects.toThrow(/refusing to migrate/);
    expect(await recordedIds()).toEqual([]);
    await restoreMigrationRecords();
  });

  test("user_version from before schema_migrations is carried over once", async () => {
    await client.execute("DELETE FROM schema_migrations;");
    await client.execute("PRAGMA user_version = 1;");
    const target = targetIn("handover");
    await runOneTimeMigrations(target);
    // The first legacy migration is adopted, only the second one runs (behind a backup).
    expect(await recordedIds()).toEqual([
      "backfill-agent-reply-content",
      "settle-server-agent-tasks",
    ]);
    expect(backupsIn(target)).toHaveLength(1);

    // Once records exist, user_version is never consulted again.
    await client.execute("PRAGMA user_version = 0;");
    await runOneTimeMigrations(targetIn("handover-after"));
    expect(backupsIn(targetIn("handover-after"))).toHaveLength(0);
    await restoreMigrationRecords();
  });

  test("a user_version OpenHorn never wrote is ignored", async () => {
    await client.execute("DELETE FROM schema_migrations;");
    await client.execute("PRAGMA user_version = 42;");
    await runOneTimeMigrations();
    expect(await recordedIds()).toEqual([
      "backfill-agent-reply-content",
      "settle-server-agent-tasks",
    ]);
    await client.execute("PRAGMA user_version = 0;");
    await restoreMigrationRecords();
  });
});

/** Rebuilds `users` in the July 2026 layout: 7 columns, NOT NULL password_hash, token_version last. */
async function installJulyUsersTable() {
  await client.execute("PRAGMA foreign_keys=OFF;");
  await client.execute(`CREATE TABLE users_july (
    id text PRIMARY KEY NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0
  );`);
  await client.execute(`INSERT INTO users_july
    SELECT id, email, username, COALESCE(password_hash, ''), created_at, updated_at, token_version
    FROM users;`);
  await client.execute("DROP TABLE users;");
  await client.execute("ALTER TABLE users_july RENAME TO users;");
  await client.execute("PRAGMA foreign_keys=ON;");
}

describe("users table from an old schema", () => {
  test("July 2026 layout boots and keeps every value under its own column", async () => {
    await installJulyUsersTable();
    const id = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO users (id, email, username, password_hash, created_at, updated_at, token_version)
            VALUES (?, ?, 'july', 'hash', 111, 222, 3);`,
      args: [id, `${id}@test.local`],
    });

    const target = targetIn("july-users");
    await bootstrapDatabase({ backup: target });

    const columns = (await client.execute("PRAGMA table_info('users');")).rows;
    const passwordHash = columns.find((row) => row.name === "password_hash");
    expect(Number(passwordHash?.notnull)).toBe(0);
    const row = (await client.execute({ sql: "SELECT * FROM users WHERE id = ?;", args: [id] }))
      .rows[0];
    expect({
      email: row?.email,
      username: row?.username,
      passwordHash: row?.password_hash,
      createdAt: Number(row?.created_at),
      updatedAt: Number(row?.updated_at),
      tokenVersion: Number(row?.token_version),
      emailVerified: Number(row?.email_verified),
    }).toEqual({
      email: `${id}@test.local`,
      username: "july",
      passwordHash: "hash",
      createdAt: 111,
      updatedAt: 222,
      tokenVersion: 3,
      emailVerified: 1,
    });
    // The rebuild was backed up, and dropped indexes were rebuilt.
    expect(backupsIn(target)).toHaveLength(1);
    const index = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'users_email_unique';",
    );
    expect(index.rows).toHaveLength(1);
    await client.execute({ sql: "DELETE FROM users WHERE id = ?;", args: [id] });
  });

  test("users stranded in users__ph_mig by the old untransacted rebuild are restored", async () => {
    const id = crypto.randomUUID();
    // What a failed boot of the old code left behind: the rows only in the copy.
    await client.execute(`CREATE TABLE users__ph_mig (
      id TEXT, email TEXT, username TEXT, password_hash TEXT,
      created_at INTEGER, updated_at INTEGER, token_version INTEGER
    );`);
    await client.execute({
      sql: `INSERT INTO users__ph_mig VALUES (?, ?, 'stranded', 'hash', 111, 222, 0);`,
      args: [id, `${id}@test.local`],
    });

    await bootstrapDatabase({ backup: targetIn("stranded") });

    const row = (await client.execute({ sql: "SELECT * FROM users WHERE id = ?;", args: [id] }))
      .rows[0];
    expect(row?.username).toBe("stranded");
    expect(Number(row?.email_verified)).toBe(1);
    const leftover = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users__ph_mig';",
    );
    expect(leftover.rows).toHaveLength(0);
    expect(backupsIn(targetIn("stranded"))).toHaveLength(1);
    await client.execute({ sql: "DELETE FROM users WHERE id = ?;", args: [id] });
  });

  test("a leftover copy whose users are all back is dropped only after a backup", async () => {
    // The live database's case: the user row was recreated by hand under the
    // same id, so the copy only holds the original email / created_at.
    const id = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO users (id, email, username, token_version, email_verified, created_at, updated_at)
            VALUES (?, ?, 'current', 0, 1, 333, 333);`,
      args: [id, `${id}@current.local`],
    });
    await client.execute(`CREATE TABLE users__ph_mig (
      id TEXT, email TEXT, username TEXT, password_hash TEXT,
      created_at INTEGER, updated_at INTEGER, token_version INTEGER
    );`);
    await client.execute({
      sql: `INSERT INTO users__ph_mig VALUES (?, ?, 'original', 'hash', 111, 222, 0);`,
      args: [id, `${id}@original.local`],
    });

    await bootstrapDatabase({ backup: targetIn("leftover") });

    const row = (await client.execute({ sql: "SELECT * FROM users WHERE id = ?;", args: [id] }))
      .rows[0];
    expect(row?.email).toBe(`${id}@current.local`);
    const leftover = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users__ph_mig';",
    );
    expect(leftover.rows).toHaveLength(0);
    expect(backupsIn(targetIn("leftover"))).toHaveLength(1);
    await client.execute({ sql: "DELETE FROM users WHERE id = ?;", args: [id] });
  });
});
