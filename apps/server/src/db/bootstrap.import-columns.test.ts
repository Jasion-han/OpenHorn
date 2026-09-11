import { describe, expect, test } from "bun:test";
import { bootstrapDatabase } from "./bootstrap";
import { client } from "./index";

async function columnNames(table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info('${table}');`);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return rows.map((row) => String((row as { name?: unknown }).name));
}

// The import-center columns are added with `ALTER TABLE ... ADD COLUMN` after
// the FK rebuild. Running bootstrap twice must neither fail (duplicate column)
// nor drop what the first pass added.
describe("bootstrapDatabase import-center schema is idempotent", () => {
  test("imported_from / imported_at and import_records survive a second bootstrap", async () => {
    await bootstrapDatabase();
    await bootstrapDatabase();

    for (const table of ["conversations", "mcp_servers"]) {
      const columns = await columnNames(table);
      expect(columns.includes("imported_from")).toBe(true);
      expect(columns.includes("imported_at")).toBe(true);
      expect(columns.filter((name) => name === "imported_from")).toHaveLength(1);
    }

    const recordColumns = await columnNames("import_records");
    for (const expected of [
      "id",
      "user_id",
      "source",
      "kind",
      "parts",
      "errors",
      "total_imported",
      "total_needs_action",
      "created_at",
    ]) {
      expect(recordColumns.includes(expected)).toBe(true);
    }

    const indexes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_records';",
    );
    const indexNames = (Array.isArray(indexes.rows) ? indexes.rows : []).map((row) =>
      String((row as { name?: unknown }).name),
    );
    expect(indexNames.includes("import_records_user_created_idx")).toBe(true);
  });
});
