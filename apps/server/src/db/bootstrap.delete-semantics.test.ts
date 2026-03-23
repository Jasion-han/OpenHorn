import { expect, test } from "bun:test";
import { client } from "./index";
import { bootstrapDatabase } from "./bootstrap";

type ForeignKeyRow = {
  table?: string;
  from?: string;
  to?: string;
  on_delete?: string;
};

async function expectForeignKey(
  tableName: string,
  params: {
    from: string;
    table: string;
    to: string;
    onDelete: string;
  },
) {
  const result = await client.execute(`PRAGMA foreign_key_list('${tableName}');`);
  const rows = (Array.isArray(result.rows) ? result.rows : []) as ForeignKeyRow[];
  expect(
    rows.some(
      (row) =>
        row.from === params.from &&
        row.table === params.table &&
        row.to === params.to &&
        String(row.on_delete || "").toUpperCase() === params.onDelete,
    ),
  ).toBe(true);
}

test("bootstrapDatabase applies delete semantics to key foreign keys", async () => {
  await bootstrapDatabase();

  await expectForeignKey("channel_models", {
    from: "channel_id",
    table: "channels",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("conversations", {
    from: "channel_id",
    table: "channels",
    to: "id",
    onDelete: "SET NULL",
  });
  await expectForeignKey("messages", {
    from: "conversation_id",
    table: "conversations",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("agent_sessions", {
    from: "conversation_id",
    table: "conversations",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("agent_sessions", {
    from: "channel_id",
    table: "channels",
    to: "id",
    onDelete: "SET NULL",
  });
  await expectForeignKey("agent_tasks", {
    from: "conversation_id",
    table: "conversations",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("agent_tasks", {
    from: "channel_id",
    table: "channels",
    to: "id",
    onDelete: "SET NULL",
  });
  await expectForeignKey("attachments", {
    from: "conversation_id",
    table: "conversations",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("attachments", {
    from: "session_id",
    table: "agent_sessions",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("attachments", {
    from: "message_id",
    table: "messages",
    to: "id",
    onDelete: "CASCADE",
  });
  await expectForeignKey("agent_events", {
    from: "session_id",
    table: "agent_sessions",
    to: "id",
    onDelete: "CASCADE",
  });
});
