import { describe, expect, test } from "bun:test";
import { bootstrapDatabase, isCreateIndexStatement } from "./bootstrap";
import { client } from "./index";

// The FK-semantics migration rebuilds 7 core tables with DROP TABLE, and SQLite
// drops a table's indexes along with it. Because that migration runs AFTER the
// SCHEMA_DDL pass, a database that took it was left with no indexes for the rest
// of the process's life. bootstrapDatabase now replays the index DDL; these
// tests guard the filter that decides what gets replayed.
describe("isCreateIndexStatement", () => {
  test("matches a plain CREATE INDEX", () => {
    expect(isCreateIndexStatement("CREATE INDEX IF NOT EXISTS foo_idx ON foo(bar);")).toBe(true);
  });

  test("matches CREATE UNIQUE INDEX", () => {
    expect(isCreateIndexStatement("CREATE UNIQUE INDEX IF NOT EXISTS foo_uniq ON foo(bar);")).toBe(
      true,
    );
  });

  test("matches despite leading whitespace and lowercase", () => {
    expect(isCreateIndexStatement("\n  create index foo_idx on foo(bar);")).toBe(true);
  });

  test("does not match CREATE TABLE", () => {
    expect(isCreateIndexStatement("CREATE TABLE IF NOT EXISTS foo (id TEXT);")).toBe(false);
  });

  // Guards against a substring match on a table whose name contains "index".
  test("does not match a table named like an index", () => {
    expect(isCreateIndexStatement("CREATE TABLE indexes (id TEXT);")).toBe(false);
  });
});

describe("bootstrapDatabase leaves the core indexes in place", () => {
  test("key indexes exist after bootstrap", async () => {
    await bootstrapDatabase();

    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%';",
    );
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const names = rows.map((row) => String((row as { name?: unknown }).name));

    // A representative index on each table the FK migration rebuilds.
    for (const expected of [
      "messages_conversation_created_idx",
      "conversations_user_idx",
      "agent_events_session_idx",
    ]) {
      expect(names.includes(expected)).toBe(true);
    }
  });
});
