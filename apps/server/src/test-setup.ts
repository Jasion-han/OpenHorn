import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Points `bun test` at a throwaway database.
 *
 * `db/index.ts` falls back to `data/openhorn.db` — the real development
 * database — when `DATABASE_URL` is unset, and the test suite never set it. So
 * every run wrote its fixtures into the database the desktop app is using: by
 * the time this was noticed there were 170 `@test.local` users, 92 conversations
 * and 106 messages sitting in it. Nothing user-visible broke (the rows belong to
 * throwaway users, so they never reached anyone's sidebar) but the tests were
 * one stray UPDATE away from corrupting real data.
 *
 * This runs as a bun `preload` (see bunfig.toml), which is the only hook that
 * fires before the test files — and therefore before `db/index.ts` reads the
 * variable at module scope. Setting it inside a test file would be too late.
 *
 * `DATABASE_URL` set in the environment still wins, so pointing a run at a
 * specific database stays possible.
 */
if (!process.env.DATABASE_URL) {
  // A fixed path wiped on the way in, rather than a fresh mkdtemp each run:
  // bun test does not fire `process.on("exit")` handlers, so anything created
  // per-run just accumulates in the temp directory. This way at most one file
  // ever exists and every run still starts from an empty database.
  const file = path.join(tmpdir(), "openhorn-server-test.db");
  for (const p of [file, `${file}-shm`, `${file}-wal`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  process.env.DATABASE_URL = `file:${file}`;

  // The fresh file has no tables. bootstrapDatabase() is the same runtime
  // migration the server runs on boot, so tests get the authoritative schema
  // rather than whatever the dev database happened to have.
  const { bootstrapDatabase } = await import("./db/bootstrap");
  await bootstrapDatabase();
}
