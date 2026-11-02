import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("legacy channel models acquire a nullable capacity without changing existing records", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "openhorn-legacy-context-window-"));
  const databaseUrl = `file:${join(scratch, "legacy.db")}`;
  const bootstrapModule = new URL("./bootstrap.ts", import.meta.url).href;
  const dbModule = new URL("./index.ts", import.meta.url).href;
  // A separate process owns this database and every DDL operation. Build the
  // other tables from the canonical schema, then reconstruct channel_models'
  // exact pre-change layout. Never DROP a column in the shared suite database.
  const script = `
    import assert from "node:assert/strict";
    const { bootstrapDatabase } = await import(${JSON.stringify(bootstrapModule)});
    const { client, databaseUrl } = await import(${JSON.stringify(dbModule)});
    assert.equal(databaseUrl, process.env.DATABASE_URL);
    await bootstrapDatabase();
    await client.execute("ALTER TABLE channel_models DROP COLUMN context_window");
    const oldColumns = (await client.execute("PRAGMA table_info(channel_models)")).rows;
    assert.equal(oldColumns.some((row) => row.name === "context_window"), false);
    await client.batch([
      "INSERT INTO users (id,email,username,password_hash,created_at,updated_at) VALUES ('legacy-u','legacy-context@test.local','legacy','opaque-password',111,222)",
      "INSERT INTO channels (id,user_id,name,provider,protocol,api_key,model,enabled,is_default,created_at,updated_at) VALUES ('legacy-c','legacy-u','Keep channel','openai','openai','opaque-key','legacy-model',1,1,111,222)",
      "INSERT INTO channel_models (id,channel_id,model_id,display_name,enabled,is_default,created_at,updated_at) VALUES ('legacy-m','legacy-c','legacy-model','Keep model label',1,1,111,222)",
      "INSERT INTO conversations (id,user_id,channel_id,model_id,title,context_length,default_mode,last_mode,created_at,updated_at) VALUES ('legacy-conv','legacy-u','legacy-c','legacy-model','Keep conversation',4096,'chat','chat',111,222)",
      "INSERT INTO messages (id,conversation_id,role,content,model,mode,created_at) VALUES ('legacy-question','legacy-conv','user','Keep question','legacy-model','chat',111)",
      { sql: "INSERT INTO messages (id,conversation_id,role,content,model,mode,usage,finish_reason,created_at) VALUES ('legacy-reply','legacy-conv','assistant','Keep reply','legacy-model','chat',?,'stopped',222)", args: [JSON.stringify({ promptTokens: 7, completionTokens: 3, totalTokens: 10 })] }
    ], "write");
    const tables = ["users", "channels", "channel_models", "conversations", "messages"];
    async function snapshot() {
      const result = {};
      for (const table of tables) {
        const rows = await client.execute("SELECT * FROM " + table + " ORDER BY id");
        result[table] = rows.rows.map((row) => Object.fromEntries(
          rows.columns.filter((column) => column !== "context_window").map((column) => [column, row[column]])
        ));
      }
      return result;
    }
    const before = await snapshot();
    await bootstrapDatabase();
    assert.deepEqual(await snapshot(), before);
    const added = (await client.execute("PRAGMA table_info(channel_models)")).rows.filter((row) => row.name === "context_window");
    assert.equal(added.length, 1);
    assert.equal(added[0].notnull, 0);
    assert.equal((await client.execute("SELECT context_window FROM channel_models WHERE id='legacy-m'")).rows[0].context_window, null);
    await client.execute("UPDATE channel_models SET context_window=1000000 WHERE id='legacy-m'");
    await bootstrapDatabase();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await client.execute("SELECT context_window FROM channel_models WHERE id='legacy-m'")).rows[0].context_window, 1000000);
    assert.equal((await client.execute("PRAGMA table_info(channel_models)")).rows.filter((row) => row.name === "context_window").length, 1);
    client.close();
    console.log(JSON.stringify({ legacyColumnAdded: true, priorRecordsUnchanged: true, overrideSurvivesRepeat: true }));
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Legacy context migration child failed: ${stderr}`);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).toEqual({
      legacyColumnAdded: true,
      priorRecordsUnchanged: true,
      overrideSurvivesRepeat: true,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
