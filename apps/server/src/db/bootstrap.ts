import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResultSet, Row } from "@libsql/client";
import { normalizeStoredAgentReply } from "../services/agentReplyNormalization";
import { selectTaskFailure, selectTaskReplyText } from "../services/agentTaskMessage";
import { client, databaseUrl } from "./index";
import { settleServerAgentTasks } from "./settleServerAgentTasks";

type ForeignKeyExpectation = {
  from: string;
  table: string;
  to: string;
  onDelete: string;
};

/** True for `CREATE INDEX` / `CREATE UNIQUE INDEX` statements in SCHEMA_DDL. */
export function isCreateIndexStatement(statement: string): boolean {
  return /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statement);
}

const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER DEFAULT 0,
    image TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);`,

  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    user_id TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS session_token_unique ON session(token);`,
  `CREATE INDEX IF NOT EXISTS session_userId_idx ON session(user_id);`,

  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    issuer TEXT,
    user_id TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at INTEGER,
    refresh_token_expires_at INTEGER,
    scope TEXT,
    password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS account_userId_idx ON account(user_id);`,

  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);`,

  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'openai',
    api_key TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );`,

  `CREATE TABLE IF NOT EXISTS channel_models (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    context_window INTEGER,
    context_metadata TEXT,
    enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS conversations (
	    id TEXT PRIMARY KEY,
	    user_id TEXT NOT NULL,
	    channel_id TEXT,
	    model_id TEXT,
	    title TEXT NOT NULL,
	    system_prompt TEXT,
	    context_length INTEGER DEFAULT 4096,
	    default_mode TEXT DEFAULT 'agent',
	    last_mode TEXT DEFAULT 'agent',
	    is_pinned INTEGER DEFAULT 0,
	    force_web_search INTEGER DEFAULT 1,
	    run_status TEXT,
	    workspace_id TEXT,
	    scheduled_task_id TEXT,
	    project_id TEXT,
	    summary TEXT,
	    key_facts TEXT,
	    last_summarized_at INTEGER,
	    imported_from TEXT,
	    imported_at INTEGER,
	    created_at INTEGER NOT NULL,
	    updated_at INTEGER NOT NULL,
	    FOREIGN KEY (user_id) REFERENCES users(id),
	    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
	  );`,

  `CREATE TABLE IF NOT EXISTS messages (
	    id TEXT PRIMARY KEY,
	    conversation_id TEXT NOT NULL,
	    role TEXT NOT NULL,
	    content TEXT NOT NULL,
	    model TEXT,
	    mode TEXT DEFAULT 'chat',
	    attachments TEXT,
	    agent_run TEXT,
	    workspace_id TEXT,
	    context_paths TEXT,
	    live_metadata TEXT,
	    citations TEXT,
	    usage TEXT,
	    finish_reason TEXT,
	    created_at INTEGER NOT NULL,
	    updated_at INTEGER,
	    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	  );`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    channel_id TEXT,
    model_id TEXT,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
  );`,

  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    channel_id TEXT,
    model_id TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    attachments TEXT,
    complexity TEXT NOT NULL DEFAULT 'deep',
    ux_mode TEXT NOT NULL DEFAULT 'full',
    requires_plan_approval INTEGER NOT NULL DEFAULT 1,
    auto_start INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
  );`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT,
    error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS agent_plan_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS agent_task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    tool_input TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS agent_approval_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    description TEXT,
    payload TEXT,
    response TEXT,
    requested_at INTEGER NOT NULL,
    responded_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS agent_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    imported_from TEXT,
    imported_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    session_id TEXT,
    message_id TEXT,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );`,

  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    frequency TEXT NOT NULL,
    time TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_on_complete INTEGER NOT NULL DEFAULT 1,
    channel_id TEXT,
    model_id TEXT,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    conversation_id TEXT,
    result TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,

  // Sidebar projects: a local folder the user added. Conversations reference it
  // through conversations.project_id (no FK — see projectService for delete
  // semantics).
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    is_starred INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS import_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    parts TEXT NOT NULL,
    errors TEXT NOT NULL,
    total_imported INTEGER NOT NULL DEFAULT 0,
    total_needs_action INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`,

  `CREATE TABLE IF NOT EXISTS agent_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    tool_input TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
  );`,

  // Indexes for hot-path lookups. SQLite does not auto-index foreign-key
  // columns, so every FK that appears in a WHERE / JOIN / ORDER BY / DELETE
  // gets an explicit index here. Keep this list in sync with the `index()`
  // declarations in packages/db/src/schema/index.ts.
  `CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);`,
  `CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS attachments_session_idx ON attachments(session_id);`,
  `CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id);`,
  `CREATE INDEX IF NOT EXISTS conversations_channel_idx ON conversations(channel_id);`,
  `CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS projects_user_root_path_idx ON projects(user_id, root_path);`,
  `CREATE INDEX IF NOT EXISTS channels_user_idx ON channels(user_id);`,
  `CREATE INDEX IF NOT EXISTS channel_models_channel_idx ON channel_models(channel_id);`,
  `CREATE INDEX IF NOT EXISTS agent_sessions_user_idx ON agent_sessions(user_id);`,
  `CREATE INDEX IF NOT EXISTS agent_sessions_conversation_idx ON agent_sessions(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS agent_sessions_channel_idx ON agent_sessions(channel_id);`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_user_idx ON agent_tasks(user_id);`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_conversation_idx ON agent_tasks(conversation_id);`,
  `CREATE INDEX IF NOT EXISTS agent_tasks_channel_idx ON agent_tasks(channel_id);`,
  `CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id);`,
  `CREATE INDEX IF NOT EXISTS agent_plan_steps_task_idx ON agent_plan_steps(task_id);`,
  `CREATE INDEX IF NOT EXISTS agent_plan_steps_run_idx ON agent_plan_steps(run_id);`,
  `CREATE INDEX IF NOT EXISTS agent_task_events_task_idx ON agent_task_events(task_id);`,
  `CREATE INDEX IF NOT EXISTS agent_task_events_run_idx ON agent_task_events(run_id);`,
  `CREATE INDEX IF NOT EXISTS agent_approval_requests_task_idx ON agent_approval_requests(task_id);`,
  `CREATE INDEX IF NOT EXISTS agent_approval_requests_run_idx ON agent_approval_requests(run_id);`,
  `CREATE INDEX IF NOT EXISTS agent_artifacts_task_idx ON agent_artifacts(task_id);`,
  `CREATE INDEX IF NOT EXISTS agent_artifacts_run_idx ON agent_artifacts(run_id);`,
  `CREATE INDEX IF NOT EXISTS agent_events_session_idx ON agent_events(session_id);`,
  `CREATE INDEX IF NOT EXISTS mcp_servers_user_idx ON mcp_servers(user_id);`,
  `CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx ON scheduled_tasks(user_id);`,
  `CREATE INDEX IF NOT EXISTS scheduled_tasks_next_run_idx ON scheduled_tasks(next_run_at);`,
  `CREATE INDEX IF NOT EXISTS scheduled_task_runs_task_idx ON scheduled_task_runs(task_id);`,
  `CREATE INDEX IF NOT EXISTS scheduled_task_runs_user_idx ON scheduled_task_runs(user_id);`,
  `CREATE INDEX IF NOT EXISTS import_records_user_created_idx ON import_records(user_id, created_at);`,
  // Duplicate (user_id, key) rows on old databases are removed by
  // dedupeSettings before this pass, or this index could not be built.
  `CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key_unique ON settings(user_id, key);`,

  // One row per applied one-time data migration (see ONE_TIME_MIGRATIONS).
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`,
];

function getRows(result: ResultSet): Row[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function normalizeForeignKeyAction(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "NO ACTION";
}

function hasColumnNamed(rows: Row[], columnName: string): boolean {
  return rows.some((row) => typeof row.name === "string" && row.name === columnName);
}

function getColumnDefaultValue(rows: Row[], columnName: string): string | null {
  const row = rows.find((item) => typeof item.name === "string" && item.name === columnName);
  const raw = row?.dflt_value;
  if (raw == null) return null;
  return String(raw)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`,
    args: [tableName],
  });
  return getRows(result).length > 0;
}

/** Column names of `tableName`, in declaration order (empty when it does not exist). */
async function tableColumnNames(tableName: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info('${tableName}');`);
  return getRows(result)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

// ---------------------------------------------------------------------------
// Backups before migrating
// ---------------------------------------------------------------------------

/** Where a database's pre-migration snapshots go, and how many to keep. */
export type MigrationBackupTarget = {
  /** Absolute path of the live database file. */
  databasePath: string;
  /** Directory the snapshots are written to. */
  directory: string;
  /** Snapshots of this database kept after a new one is written (oldest pruned first). */
  keep: number;
};

const DEFAULT_BACKUP_KEEP = 5;

/**
 * Backup target for a libsql URL: `<db dir>/backups/`, or null for databases
 * there is no file to snapshot (in-memory, remote).
 */
export function resolveMigrationBackupTarget(
  url: string | undefined,
  keep = DEFAULT_BACKUP_KEEP,
): MigrationBackupTarget | null {
  if (!url || !url.startsWith("file:")) return null;
  const withoutQuery = url.split("?")[0] ?? "";
  const rest = withoutQuery.slice("file:".length);
  if (!rest || rest.includes(":memory:")) return null;
  const databasePath = rest.startsWith("//") ? fileURLToPath(withoutQuery) : path.resolve(rest);
  return { databasePath, directory: path.join(path.dirname(databasePath), "backups"), keep };
}

function backupFilePrefix(target: MigrationBackupTarget): string {
  return `${path.basename(target.databasePath).replace(/\.[^.]+$/, "")}-`;
}

/** `<name>-2026-10-31T14-53-00-123Z-v2.db`: sorts chronologically by name. */
function isBackupFileOf(target: MigrationBackupTarget, fileName: string): boolean {
  const prefix = backupFilePrefix(target);
  return (
    fileName.startsWith(prefix) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-v\d+\.db$/.test(fileName.slice(prefix.length))
  );
}

/**
 * How far this database's migrations got: the number of recorded one-time
 * migrations, or the legacy `user_version` count before the record table has
 * any rows. Only used to label backups.
 */
async function readMigrationLevel(): Promise<number> {
  if (await tableExists("schema_migrations")) {
    const result = await client.execute(`SELECT COUNT(*) AS n FROM schema_migrations;`);
    const count = Number(getRows(result)[0]?.n ?? 0);
    if (count > 0) return count;
  }
  return readUserVersion();
}

/**
 * Writes a consistent snapshot of the live database (`VACUUM INTO`) and prunes
 * this database's older snapshots down to `target.keep`. Throws when the
 * snapshot cannot be written — callers must not migrate then. Exported for tests.
 */
export async function createMigrationBackup(
  target: MigrationBackupTarget,
  reason: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const level = await readMigrationLevel();
  const file = path.join(target.directory, `${backupFilePrefix(target)}${stamp}-v${level}.db`);
  try {
    mkdirSync(target.directory, { recursive: true });
    await client.execute(`VACUUM INTO '${file.replaceAll("'", "''")}';`);
  } catch (error) {
    try {
      rmSync(file, { force: true }); // a partial snapshot, if any
    } catch {
      // The directory itself may be unusable; the original error is what matters.
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[db] Could not back up ${target.databasePath} to ${file} before ${reason}; ` +
        `refusing to migrate without a backup. ${detail}`,
      { cause: error },
    );
  }
  console.log(`[db] Backed up the database to ${file} before ${reason}.`);

  try {
    const snapshots = readdirSync(target.directory)
      .filter((name) => isBackupFileOf(target, name))
      .sort();
    for (const name of snapshots.slice(0, Math.max(0, snapshots.length - target.keep))) {
      rmSync(path.join(target.directory, name), { force: true });
    }
  } catch (error) {
    console.warn("[db] Could not prune old migration backups:", error);
  }
  return file;
}

/**
 * Takes at most one snapshot per bootstrap, right before the first step that
 * would delete rows, overwrite existing values or rebuild a table. Steps that
 * only add tables / columns / indexes, or fill in NULLs of a column they just
 * added, do not call it — so a boot with nothing to migrate copies nothing.
 *
 * A database that had no tables when bootstrap started has nothing to lose
 * and is never backed up.
 */
class MigrationBackup {
  private taken = false;

  constructor(
    private readonly target: MigrationBackupTarget | null,
    private readonly hasExistingData: boolean,
  ) {}

  /** Must be called outside a transaction (`VACUUM INTO` cannot run in one). */
  async ensure(reason: string): Promise<void> {
    if (this.taken || !this.target || !this.hasExistingData) return;
    await createMigrationBackup(this.target, reason);
    this.taken = true;
  }
}

// ---------------------------------------------------------------------------
// Table rebuilds
// ---------------------------------------------------------------------------

/**
 * SCHEMA_DDL's `CREATE TABLE` for `tableName`, renamed to `as`. Table rebuilds
 * use it so the rebuilt table always has the current, complete column list —
 * a hand-copied list goes stale and silently drops every column added later.
 */
function canonicalCreateTable(tableName: string, as: string): string {
  const head = new RegExp(`^\\s*CREATE TABLE IF NOT EXISTS ${tableName} \\(`);
  const statement = SCHEMA_DDL.find((stmt) => head.test(stmt));
  if (!statement) throw new Error(`[db] No CREATE TABLE for ${tableName} in SCHEMA_DDL`);
  return statement.replace(head, `CREATE TABLE ${as} (`);
}

/**
 * `INSERT INTO to SELECT ... FROM from`, matching columns BY NAME. Columns the
 * source lacks take the target's default; a NULL going into a `NOT NULL
 * DEFAULT` column takes the default; `overrides` replace a column's value
 * with a SQL expression. Source columns the target no longer has are dropped
 * (logged — the pre-migration backup still holds them).
 */
async function buildCopyStatement(
  from: string,
  to: string,
  overrides: Record<string, string>,
): Promise<string> {
  const sourceColumns = new Set(await tableColumnNames(from));
  const targetRows = getRows(await client.execute(`PRAGMA table_info('${to}');`));
  const columns: string[] = [];
  const values: string[] = [];
  for (const row of targetRows) {
    const name = String(row.name);
    const override = overrides[name];
    if (override !== undefined) {
      columns.push(`"${name}"`);
      values.push(override);
      continue;
    }
    if (!sourceColumns.has(name)) continue;
    columns.push(`"${name}"`);
    values.push(
      Number(row.notnull) === 1 && row.dflt_value != null
        ? `COALESCE("${name}", ${String(row.dflt_value)})`
        : `"${name}"`,
    );
  }
  const targetNames = new Set(targetRows.map((row) => String(row.name)));
  const dropped = [...sourceColumns].filter((name) => !targetNames.has(name));
  if (dropped.length > 0) {
    console.warn(`[db] Rebuilding ${from} drops obsolete columns: ${dropped.join(", ")}`);
  }
  return `INSERT INTO "${to}" (${columns.join(", ")}) SELECT ${values.join(", ")} FROM "${from}";`;
}

type TableRebuild = {
  table: string;
  /** Column → SQL expression used instead of the copied value. */
  overrides?: Record<string, string>;
};

/**
 * Recreates tables from their SCHEMA_DDL definition (to change constraints
 * SQLite cannot ALTER), copying rows by column name. Backs up first, runs in
 * one transaction (a failure leaves every table as it was), and replays the
 * index DDL afterwards — SQLite drops a table's indexes with the table.
 */
async function rebuildTables(
  rebuilds: TableRebuild[],
  backup: MigrationBackup,
  reason: string,
): Promise<void> {
  await backup.ensure(reason);
  // Must be set outside the transaction: inside one, PRAGMA foreign_keys is a
  // no-op, and DROP TABLE with enforcement on would cascade-delete child rows.
  await client.execute("PRAGMA foreign_keys=OFF;");
  try {
    await client.execute("BEGIN;");
    try {
      for (const { table, overrides } of rebuilds) {
        const temp = `${table}__migrated`;
        await client.execute(`DROP TABLE IF EXISTS ${temp};`);
        await client.execute(canonicalCreateTable(table, temp));
        await client.execute(await buildCopyStatement(table, temp, overrides ?? {}));
      }
      for (const { table } of rebuilds) {
        await client.execute(`DROP TABLE ${table};`);
      }
      for (const { table } of rebuilds) {
        await client.execute(`ALTER TABLE ${table}__migrated RENAME TO ${table};`);
      }
      await client.execute("COMMIT;");
    } catch (error) {
      try {
        await client.execute("ROLLBACK;");
      } catch {
        // SQLite may already have rolled back; the original error is what matters.
      }
      throw error;
    }
  } finally {
    await client.execute("PRAGMA foreign_keys=ON;");
  }
  for (const stmt of SCHEMA_DDL) {
    if (isCreateIndexStatement(stmt)) {
      await client.execute(stmt);
    }
  }
}

/**
 * Old databases may hold duplicate (user_id, key) settings rows from the
 * delete-then-insert code before the upsert fix. Removes the dupes (keeping
 * the latest = highest rowid) so the unique index in SCHEMA_DDL can be built.
 * Must run before the SCHEMA_DDL pass.
 */
async function dedupeSettings(backup: MigrationBackup): Promise<void> {
  if (!(await tableExists("settings"))) return;
  const dupes = await client.execute(
    `SELECT 1 FROM settings GROUP BY user_id, key HAVING COUNT(*) > 1 LIMIT 1;`,
  );
  if (getRows(dupes).length === 0) return;
  await backup.ensure("removing duplicate settings rows");
  await client.execute(
    `DELETE FROM settings WHERE rowid NOT IN (SELECT MAX(rowid) FROM settings GROUP BY user_id, key);`,
  );
}

async function ensureUserTokenVersionColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('users');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "token_version")) {
    await client.execute(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;`);
  }
}

async function ensureConversationModelIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "model_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN model_id TEXT;`);
  }
}

async function ensureChannelModelContextWindowColumn(): Promise<void> {
  const columns = await client.execute("PRAGMA table_info(channel_models)");
  if (!columns.rows.some((row) => row.name === "context_window")) {
    await client.execute("ALTER TABLE channel_models ADD COLUMN context_window INTEGER");
  }
}

async function ensureChannelModelContextMetadataColumn(): Promise<void> {
  const result = await client.execute("PRAGMA table_info(channel_models)");
  if (!result.rows.some((row) => row.name === "context_metadata")) {
    await client.execute("ALTER TABLE channel_models ADD COLUMN context_metadata TEXT");
  }
}

async function ensureChannelProtocolColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('channels');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "protocol")) {
    await client.execute(`ALTER TABLE channels ADD COLUMN protocol TEXT DEFAULT 'openai';`);
  }

  await client.execute(`
    UPDATE channels
    SET protocol = CASE
      WHEN lower(trim(provider)) = 'anthropic' THEN 'anthropic'
      WHEN lower(trim(provider)) IN ('google', 'gemini') THEN 'google'
      ELSE 'openai'
    END
    WHERE protocol IS NULL OR trim(protocol) = '';
  `);
}

async function ensureConversationDefaultModeColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "default_mode");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN default_mode TEXT DEFAULT 'agent';`);
    await client.execute(
      `UPDATE conversations SET default_mode = 'agent' WHERE default_mode IS NULL;`,
    );
  }
}

async function ensureConversationLastModeColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "last_mode");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN last_mode TEXT DEFAULT 'agent';`);
    await client.execute(`UPDATE conversations SET last_mode = 'agent' WHERE last_mode IS NULL;`);
  }
}

async function ensureConversationRunStatusColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "run_status");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN run_status TEXT;`);
  }
}

async function ensureConversationForceWebSearchColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "force_web_search");
  if (!hasColumn) {
    await client.execute(
      `ALTER TABLE conversations ADD COLUMN force_web_search INTEGER DEFAULT 1;`,
    );
    await client.execute(
      `UPDATE conversations SET force_web_search = 1 WHERE force_web_search IS NULL;`,
    );
  }
}

async function ensureConversationForceWebSearchEnabledByDefault(
  backup: MigrationBackup,
): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const defaultValue = getColumnDefaultValue(rows, "force_web_search");
  if (defaultValue === "1") {
    return;
  }
  // Changing a column default needs a rebuild; existing rows are switched on too.
  await rebuildTables(
    [{ table: "conversations", overrides: { force_web_search: "1" } }],
    backup,
    "enabling web search by default",
  );
}

async function ensureConversationWorkspaceIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "workspace_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT;`);
  }
}

async function ensureMessageModeColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "mode");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN mode TEXT DEFAULT 'chat';`);
    await client.execute(`UPDATE messages SET mode = 'chat' WHERE mode IS NULL;`);
  }
}

async function ensureMessageAgentRunColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "agent_run");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN agent_run TEXT;`);
  }
}

async function ensureMessageWorkspaceIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "workspace_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN workspace_id TEXT;`);
  }
}

async function ensureMessageContextPathsColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "context_paths");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN context_paths TEXT;`);
  }
}

async function ensureMessageLiveMetadataColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "live_metadata");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN live_metadata TEXT;`);
  }
}

async function ensureMessageCitationsColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "citations");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN citations TEXT;`);
  }
}

async function ensureMessageUsageColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "usage");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN usage TEXT;`);
  }
}

// Additive and nullable: existing rows read as "ran to completion", which is
// what they were as far as anything recorded — no backfill, so no backup.
async function ensureMessageFinishReasonColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "finish_reason");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN finish_reason TEXT;`);
  }
}

async function ensureMessageUpdatedAtColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('messages');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "updated_at");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE messages ADD COLUMN updated_at INTEGER;`);
  }
}

async function ensureMcpServerUserIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('mcp_servers');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "user_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE mcp_servers ADD COLUMN user_id TEXT;`);

    const users = await client.execute(`SELECT id FROM users LIMIT 2;`);
    const userRows = getRows(users);
    const userId =
      userRows.length === 1 && typeof userRows[0]?.id === "string" ? userRows[0].id : null;
    if (userId) {
      await client.execute(`
        UPDATE mcp_servers
        SET user_id = '${userId}'
        WHERE user_id IS NULL;
      `);
    }
  }
}

async function ensureAgentSessionModelIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_sessions');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "model_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE agent_sessions ADD COLUMN model_id TEXT;`);
  }
}

async function ensureAgentSessionConversationIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_sessions');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "conversation_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE agent_sessions ADD COLUMN conversation_id TEXT;`);
  }
}

async function ensureAttachmentsSessionIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('attachments');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "session_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE attachments ADD COLUMN session_id TEXT;`);
  }
}

async function ensureAgentEventsTable(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_events');`);
  const rows = getRows(result);
  if (rows.length === 0) {
    await client.execute(`CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );`);
  }
}

async function tableHasExpectedForeignKeys(
  tableName: string,
  expectedForeignKeys: ForeignKeyExpectation[],
): Promise<boolean> {
  const result = await client.execute(`PRAGMA foreign_key_list('${tableName}');`);
  const rows = getRows(result);
  if (rows.length !== expectedForeignKeys.length) {
    return false;
  }

  return expectedForeignKeys.every((expected) =>
    rows.some(
      (row) =>
        row.from === expected.from &&
        row.table === expected.table &&
        row.to === expected.to &&
        normalizeForeignKeyAction(row.on_delete) === expected.onDelete,
    ),
  );
}

/**
 * Rebuilds the 7 core tables (all together) when any of their foreign keys
 * lacks the expected ON DELETE semantics.
 */
async function ensureDeleteSemanticsForeignKeys(backup: MigrationBackup): Promise<void> {
  const expectations: Array<{ tableName: string; foreignKeys: ForeignKeyExpectation[] }> = [
    {
      tableName: "channel_models",
      foreignKeys: [{ from: "channel_id", table: "channels", to: "id", onDelete: "CASCADE" }],
    },
    {
      tableName: "conversations",
      foreignKeys: [
        { from: "user_id", table: "users", to: "id", onDelete: "NO ACTION" },
        { from: "channel_id", table: "channels", to: "id", onDelete: "SET NULL" },
      ],
    },
    {
      tableName: "messages",
      foreignKeys: [
        {
          from: "conversation_id",
          table: "conversations",
          to: "id",
          onDelete: "CASCADE",
        },
      ],
    },
    {
      tableName: "agent_sessions",
      foreignKeys: [
        { from: "user_id", table: "users", to: "id", onDelete: "NO ACTION" },
        {
          from: "conversation_id",
          table: "conversations",
          to: "id",
          onDelete: "CASCADE",
        },
        { from: "channel_id", table: "channels", to: "id", onDelete: "SET NULL" },
      ],
    },
    {
      tableName: "agent_tasks",
      foreignKeys: [
        { from: "user_id", table: "users", to: "id", onDelete: "NO ACTION" },
        {
          from: "conversation_id",
          table: "conversations",
          to: "id",
          onDelete: "CASCADE",
        },
        { from: "channel_id", table: "channels", to: "id", onDelete: "SET NULL" },
      ],
    },
    {
      tableName: "attachments",
      foreignKeys: [
        {
          from: "conversation_id",
          table: "conversations",
          to: "id",
          onDelete: "CASCADE",
        },
        {
          from: "session_id",
          table: "agent_sessions",
          to: "id",
          onDelete: "CASCADE",
        },
        {
          from: "message_id",
          table: "messages",
          to: "id",
          onDelete: "CASCADE",
        },
      ],
    },
    {
      tableName: "agent_events",
      foreignKeys: [
        {
          from: "session_id",
          table: "agent_sessions",
          to: "id",
          onDelete: "CASCADE",
        },
      ],
    },
  ];

  const matches = await Promise.all(
    expectations.map((item) => tableHasExpectedForeignKeys(item.tableName, item.foreignKeys)),
  );
  if (matches.every(Boolean)) {
    return;
  }

  await rebuildTables(
    expectations.map((item) => ({ table: item.tableName })),
    backup,
    "rebuilding tables for foreign-key delete semantics",
  );
}

async function ensureAgentTaskComplexityColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_tasks');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "complexity")) {
    await client.execute(`ALTER TABLE agent_tasks ADD COLUMN complexity TEXT DEFAULT 'deep';`);
    await client.execute(`UPDATE agent_tasks SET complexity = 'deep' WHERE complexity IS NULL;`);
  }
}

async function ensureAgentTaskUxModeColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_tasks');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "ux_mode")) {
    await client.execute(`ALTER TABLE agent_tasks ADD COLUMN ux_mode TEXT DEFAULT 'full';`);
    await client.execute(`UPDATE agent_tasks SET ux_mode = 'full' WHERE ux_mode IS NULL;`);
  }
}

async function ensureAgentTaskRequiresPlanApprovalColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_tasks');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "requires_plan_approval")) {
    await client.execute(
      `ALTER TABLE agent_tasks ADD COLUMN requires_plan_approval INTEGER DEFAULT 1;`,
    );
    await client.execute(
      `UPDATE agent_tasks SET requires_plan_approval = 1 WHERE requires_plan_approval IS NULL;`,
    );
  }
}

async function ensureAgentTaskAutoStartColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_tasks');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "auto_start")) {
    await client.execute(`ALTER TABLE agent_tasks ADD COLUMN auto_start INTEGER DEFAULT 0;`);
    await client.execute(`UPDATE agent_tasks SET auto_start = 0 WHERE auto_start IS NULL;`);
  }
}

/**
 * Makes `users.password_hash` nullable (OAuth / local users have none) by
 * rebuilding the table.
 *
 * This used to copy with `INSERT INTO users SELECT * FROM <copy>`: positional,
 * so a database whose users table had a different column count or order
 * (e.g. July 2026: 7 columns with token_version last) failed with "table users
 * has 9 columns but 7 values" — and because nothing ran in a transaction, the
 * failure left `users` dropped-and-empty with the rows stranded in
 * `users__ph_mig`, where the next boot's cleanup would delete them.
 */
async function ensurePasswordHashNullable(backup: MigrationBackup): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('users');`);
  const col = getRows(result).find((row) => row.name === "password_hash");
  if (col && Number(col.notnull) === 1) {
    await rebuildTables([{ table: "users" }], backup, "making users.password_hash nullable");
  }
}

/**
 * Puts back the users stranded by an interrupted run of the old, untransacted
 * password_hash rebuild (see ensurePasswordHashNullable): rows still in
 * `users__ph_mig` that `users` lacks are restored by column name, and the copy
 * is dropped once every row is back. Runs before ensureDefaultLocalUser so a
 * restored database does not also get a fresh local user.
 */
async function recoverInterruptedUsersRebuild(backup: MigrationBackup): Promise<void> {
  if (!(await tableExists("users__ph_mig"))) return;
  // Every path below writes users or drops the copy, and the copy can be the
  // only record of a user's original values (email, created_at) even when the
  // id is back in users — e.g. a user row recreated by hand.
  await backup.ensure("restoring users from an interrupted users rebuild");
  const missing = await client.execute(
    `SELECT COUNT(*) AS n FROM users__ph_mig WHERE id NOT IN (SELECT id FROM users);`,
  );
  if (Number(getRows(missing)[0]?.n ?? 0) > 0) {
    const source = new Set(await tableColumnNames("users__ph_mig"));
    const columns = (await tableColumnNames("users")).filter((name) => source.has(name));
    const list = columns.map((name) => `"${name}"`).join(", ");
    // Same rule as ensureUserEmailVerifiedColumn: pre-existing users are verified.
    const verified = source.has("email_verified") ? "" : ", email_verified";
    await client.execute(
      `INSERT OR IGNORE INTO users (${list}${verified})
       SELECT ${list}${verified ? ", 1" : ""} FROM users__ph_mig
       WHERE id NOT IN (SELECT id FROM users);`,
    );
  }
  const stillMissing = await client.execute(
    `SELECT COUNT(*) AS n FROM users__ph_mig WHERE id NOT IN (SELECT id FROM users);`,
  );
  if (Number(getRows(stillMissing)[0]?.n ?? 0) === 0) {
    await client.execute(`DROP TABLE users__ph_mig;`);
  } else {
    console.warn("[db] users__ph_mig holds users that could not be restored; leaving it in place.");
  }
}

async function ensureDefaultLocalUser(): Promise<void> {
  const result = await client.execute(`SELECT COUNT(*) as cnt FROM users;`);
  const count = (result.rows[0] as Record<string, unknown>)?.cnt as number;
  if (count === 0) {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const osUsername = userInfo().username || "User";
    await client.execute({
      sql: `INSERT INTO users (id, email, username, token_version, email_verified, created_at, updated_at)
            VALUES (?, ?, ?, 0, 1, ?, ?)`,
      args: [id, "local@openhorn.local", osUsername, now, now],
    });
  }
}

async function ensureUserEmailVerifiedColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('users');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "email_verified")) {
    await client.execute(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;`);
    await client.execute(`UPDATE users SET email_verified = 1;`);
  }
}

async function ensureUserImageColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('users');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "image")) {
    await client.execute(`ALTER TABLE users ADD COLUMN image TEXT;`);
  }
}

async function ensureAccountIssuerColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('account');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "issuer")) {
    await client.execute(`ALTER TABLE account ADD COLUMN issuer TEXT;`);
  }
}

async function migratePasswordsToAccountTable(): Promise<void> {
  const usersWithPassword = await client.execute(`
    SELECT u.id, u.password_hash
    FROM users u
    WHERE u.password_hash IS NOT NULL
      AND u.password_hash != ''
      AND NOT EXISTS (
        SELECT 1 FROM account a
        WHERE a.user_id = u.id AND a.provider_id = 'credential'
      );
  `);

  const rows = getRows(usersWithPassword);
  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    const userId = row.id as string;
    const passwordHash = row.password_hash as string;
    const accountId = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO account (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at) VALUES (?, ?, 'credential', 'local:credential', ?, ?, ?, ?);`,
      args: [accountId, userId, userId, passwordHash, now, now],
    });
  }

  await client.execute(
    `UPDATE account SET issuer = 'local:credential' WHERE provider_id = 'credential' AND (issuer IS NULL OR issuer = '');`,
  );
}

async function ensureConversationSummaryColumns(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  if (!hasColumnNamed(rows, "summary")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN summary TEXT;`);
  }
  if (!hasColumnNamed(rows, "key_facts")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN key_facts TEXT;`);
  }
  if (!hasColumnNamed(rows, "last_summarized_at")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN last_summarized_at INTEGER;`);
  }
}

async function ensureScheduledTaskRunConversationIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('scheduled_task_runs');`);
  const rows = getRows(result);
  if (rows.length > 0 && !hasColumnNamed(rows, "conversation_id")) {
    await client.execute(`ALTER TABLE scheduled_task_runs ADD COLUMN conversation_id TEXT;`);
  }
}

async function ensureConversationScheduledTaskIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  if (rows.length > 0 && !hasColumnNamed(rows, "scheduled_task_id")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN scheduled_task_id TEXT;`);
    // Backfill conversations that already belong to a scheduled run but predate
    // this column, so they drop out of the user's chat list retroactively.
    await client.execute(
      `UPDATE conversations SET scheduled_task_id = (
         SELECT r.task_id FROM scheduled_task_runs r
         WHERE r.conversation_id = conversations.id
         ORDER BY r.started_at LIMIT 1
       )
       WHERE scheduled_task_id IS NULL
         AND id IN (SELECT conversation_id FROM scheduled_task_runs WHERE conversation_id IS NOT NULL);`,
    );
    // Older scheduled runs (pre-run-link runtime) left conversations with no run
    // row at all — the only marker is the legacy "[定时任务自动触发]" prompt prefix.
    // Flag those whose title still matches one of the user's scheduled tasks. Both
    // conditions together make a false positive (a real chat) effectively impossible.
    await client.execute(
      `UPDATE conversations SET scheduled_task_id = (
         SELECT t.id FROM scheduled_tasks t
         WHERE t.title = conversations.title AND t.user_id = conversations.user_id
         LIMIT 1
       )
       WHERE scheduled_task_id IS NULL
         AND EXISTS (
           SELECT 1 FROM scheduled_tasks t
           WHERE t.title = conversations.title AND t.user_id = conversations.user_id
         )
         AND id IN (
           SELECT m.conversation_id FROM messages m
           WHERE m.role = 'user' AND m.content LIKE '[定时任务自动触发]%'
         );`,
    );
  }
}

async function ensureConversationProjectIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  if (rows.length > 0 && !hasColumnNamed(rows, "project_id")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN project_id TEXT;`);
  }
  // Not in SCHEMA_DDL: that pass runs before the ALTER above, and CREATE INDEX
  // on a column that does not exist yet fails the whole bootstrap.
  await client.execute(
    `CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations(project_id);`,
  );
}

async function ensureConversationImportColumns(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  if (rows.length === 0) return;
  if (!hasColumnNamed(rows, "imported_from")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN imported_from TEXT;`);
  }
  if (!hasColumnNamed(rows, "imported_at")) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN imported_at INTEGER;`);
  }
}

async function ensureMcpServerImportColumns(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('mcp_servers');`);
  const rows = getRows(result);
  if (rows.length === 0) return;
  if (!hasColumnNamed(rows, "imported_from")) {
    await client.execute(`ALTER TABLE mcp_servers ADD COLUMN imported_from TEXT;`);
  }
  if (!hasColumnNamed(rows, "imported_at")) {
    await client.execute(`ALTER TABLE mcp_servers ADD COLUMN imported_at INTEGER;`);
  }
}

async function ensureMessagesFtsTable(): Promise<void> {
  const check = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts';`,
  );
  if (getRows(check).length > 0) return;

  await client.execute(
    `CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      conversation_id UNINDEXED,
      content,
      tokenize='trigram'
    );`,
  );

  // Backfill existing messages (truncate long content to 5000 chars for index efficiency)
  await client.execute(
    `INSERT INTO messages_fts(message_id, conversation_id, content)
     SELECT id, conversation_id, substr(content, 1, 5000) FROM messages;`,
  );
}

/**
 * Brings every stored agent reply in line with the reply-text invariant —
 * `content` = the run's text steps, failures in `agentRun.error` — and re-points
 * the FTS row whenever `content` changes. See `normalizeStoredAgentReply` for
 * the legacy row shapes. Task-backed rows whose task still exists are rebuilt
 * from the task's full final_result (they used to store the 160-char card
 * preview, or the error string), selecting the result as `agentTaskMessage` does.
 *
 * Idempotent: a row already in line normalizes to itself and is not written.
 * Runs once per database (see ONE_TIME_MIGRATIONS). Exported for tests.
 */
export async function backfillAgentReplyContent(): Promise<number> {
  const result = await client.execute(
    `SELECT id, conversation_id, content, agent_run FROM messages
     WHERE role = 'assistant' AND agent_run IS NOT NULL;`,
  );
  const rows = getRows(result).map((row) => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    content: typeof row.content === "string" ? row.content : "",
    agentRun: typeof row.agent_run === "string" ? row.agent_run : null,
  }));
  const tasks = await loadTaskReplies(
    rows.map((row) => taskIdOf(row.agentRun)).filter((id): id is string => id !== null),
  );

  let changed = 0;
  for (const row of rows) {
    const taskId = taskIdOf(row.agentRun);
    const next = normalizeStoredAgentReply(
      { content: row.content, agentRun: row.agentRun },
      taskId ? tasks.get(taskId) : undefined,
    );
    if (next.content === row.content && next.agentRun === row.agentRun) continue;
    await client.execute({
      sql: `UPDATE messages SET content = ?, agent_run = ? WHERE id = ?;`,
      args: [next.content, next.agentRun, row.id],
    });
    if (next.content !== row.content) {
      await client.execute({
        sql: `DELETE FROM messages_fts WHERE message_id = ?;`,
        args: [row.id],
      });
      if (next.content) {
        await client.execute({
          sql: `INSERT INTO messages_fts(message_id, conversation_id, content) VALUES (?, ?, ?);`,
          args: [row.id, row.conversationId, next.content.substring(0, 5000)],
        });
      }
    }
    changed++;
  }
  return changed;
}

function taskIdOf(agentRun: string | null): string | null {
  if (!agentRun || !agentRun.includes('"taskId"')) return null;
  try {
    const taskId = (JSON.parse(agentRun) as { taskId?: unknown } | null)?.taskId;
    return typeof taskId === "string" && taskId ? taskId : null;
  } catch {
    return null;
  }
}

/** Reply text + failure for each task that still exists, keyed by task id. */
async function loadTaskReplies(
  taskIds: string[],
): Promise<Map<string, { replyText: string; failure?: string }>> {
  const replies = new Map<string, { replyText: string; failure?: string }>();
  if (taskIds.length === 0) return replies;
  const ids = JSON.stringify([...new Set(taskIds)]);
  const inIds = "IN (SELECT value FROM json_each(?))";
  const [taskRows, runRows, artifactRows] = await Promise.all([
    client.execute({ sql: `SELECT id, status FROM agent_tasks WHERE id ${inIds};`, args: [ids] }),
    client.execute({
      sql: `SELECT id, task_id, phase, error FROM agent_runs WHERE task_id ${inIds}
            ORDER BY created_at DESC;`,
      args: [ids],
    }),
    client.execute({
      sql: `SELECT task_id, run_id, type, content FROM agent_artifacts
            WHERE type = 'final_result' AND task_id ${inIds} ORDER BY created_at DESC;`,
      args: [ids],
    }),
  ]);

  const runsByTask = new Map<string, Array<{ id: string; phase: string; error: string | null }>>();
  for (const row of getRows(runRows)) {
    const list = runsByTask.get(String(row.task_id)) ?? [];
    list.push({
      id: String(row.id),
      phase: String(row.phase),
      error: typeof row.error === "string" ? row.error : null,
    });
    runsByTask.set(String(row.task_id), list);
  }
  const artifactsByTask = new Map<
    string,
    Array<{ runId: string; type: string; content: string }>
  >();
  for (const row of getRows(artifactRows)) {
    const list = artifactsByTask.get(String(row.task_id)) ?? [];
    list.push({
      runId: String(row.run_id),
      type: String(row.type),
      content: typeof row.content === "string" ? row.content : "",
    });
    artifactsByTask.set(String(row.task_id), list);
  }
  for (const row of getRows(taskRows)) {
    const taskId = String(row.id);
    const runs = runsByTask.get(taskId) ?? [];
    replies.set(taskId, {
      replyText: selectTaskReplyText(runs, artifactsByTask.get(taskId) ?? []),
      failure: selectTaskFailure(String(row.status), runs),
    });
  }
  return replies;
}

export type BootstrapOptions = {
  /**
   * Where to snapshot the database before migrating. Defaults to
   * `<db dir>/backups/` for a file database, and to none under `bun test`
   * (NODE_ENV=test) or for in-memory / remote databases. `null` disables.
   */
  backup?: MigrationBackupTarget | null;
};

function defaultBackupTarget(): MigrationBackupTarget | null {
  if (process.env.NODE_ENV === "test") return null;
  return resolveMigrationBackupTarget(databaseUrl);
}

export async function bootstrapDatabase(options: BootstrapOptions = {}): Promise<void> {
  await client.execute("PRAGMA foreign_keys=ON;");

  const existing = await client.execute(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';`,
  );
  const backup = new MigrationBackup(
    options.backup === undefined ? defaultBackupTarget() : options.backup,
    Number(getRows(existing)[0]?.n ?? 0) > 0,
  );

  // Before the SCHEMA_DDL pass, which builds the settings unique index.
  await dedupeSettings(backup);

  for (const stmt of SCHEMA_DDL) {
    await client.execute(stmt);
  }

  // Backward compatible alter for databases created before model_id existed.
  await ensureUserTokenVersionColumn();
  await ensureChannelProtocolColumn();
  await ensureChannelModelContextWindowColumn();
  await ensureChannelModelContextMetadataColumn();
  await ensureConversationModelIdColumn();
  await ensureConversationDefaultModeColumn();
  await ensureConversationLastModeColumn();
  await ensureConversationForceWebSearchColumn();
  await ensureConversationRunStatusColumn();
  await ensureConversationWorkspaceIdColumn();
  await ensureMessageModeColumn();
  await ensureMessageAgentRunColumn();
  await ensureMessageWorkspaceIdColumn();
  await ensureMessageContextPathsColumn();
  await ensureMessageLiveMetadataColumn();
  await ensureMessageCitationsColumn();
  await ensureMessageUsageColumn();
  await ensureMessageUpdatedAtColumn();
  await ensureMessageFinishReasonColumn();
  await ensureMcpServerUserIdColumn();
  await ensureAgentEventsTable();
  await ensureAgentSessionModelIdColumn();
  await ensureAgentSessionConversationIdColumn();
  await ensureAgentTaskComplexityColumn();
  await ensureAgentTaskUxModeColumn();
  await ensureAgentTaskRequiresPlanApprovalColumn();
  await ensureAgentTaskAutoStartColumn();
  await ensureAttachmentsSessionIdColumn();

  // Before the users rebuild, so it copies these columns instead of creating
  // them with defaults (pre-existing users count as verified).
  await ensureUserEmailVerifiedColumn();
  await ensureUserImageColumn();
  await recoverInterruptedUsersRebuild(backup);
  await ensurePasswordHashNullable(backup);
  await ensureAccountIssuerColumn();
  await migratePasswordsToAccountTable();
  await ensureDefaultLocalUser();

  await ensureConversationSummaryColumns();
  await ensureScheduledTaskRunConversationIdColumn();
  // Before any conversations rebuild: its backfill only runs when it adds the
  // column, and a rebuild from SCHEMA_DDL would add it empty.
  await ensureConversationScheduledTaskIdColumn();

  // Table rebuilds. Both copy rows by column name into the SCHEMA_DDL
  // definition, so no column added above is lost, and replay the index DDL.
  await ensureConversationForceWebSearchEnabledByDefault(backup);
  await ensureDeleteSemanticsForeignKeys(backup);

  // No-ops after a rebuild (SCHEMA_DDL already has these columns); on other
  // databases they add what is missing.
  await ensureConversationProjectIdColumn();
  await ensureConversationImportColumns();
  await ensureMcpServerImportColumns();

  // FTS5 virtual table for full-text search over message content. Must run
  // after the rebuilds (which may recreate the messages table) so the backfill
  // reads the final rows.
  await ensureMessagesFtsTable();

  // After the FTS table exists, so backfilled text is indexed too. Reads
  // agent_tasks / agent_runs / agent_artifacts, all created above.
  await applyOneTimeMigrations(backup);
}

type OneTimeMigration = {
  /** Recorded in `schema_migrations` once applied. Never rename. */
  id: string;
  run: () => Promise<unknown>;
};

/**
 * Data migrations that only ever need to run once per database, in order.
 * Each is recorded by id in `schema_migrations` once it has run, and never
 * runs again. Append only; never rename an id. Pending ones run after a
 * pre-migration backup (see MigrationBackup).
 *
 * Schema changes do not belong here — they stay idempotent `ensure*` steps
 * above, which also cover a database rebuilt from SCHEMA_DDL.
 */
const ONE_TIME_MIGRATIONS: readonly OneTimeMigration[] = [
  // Server-run agent turns can no longer execute or be approved: settle the
  // ones left open. Before the backfill, so it sees the final statuses.
  { id: "settle-server-agent-tasks", run: settleServerAgentTasks },
  // Reply-text invariant for agent rows stored before it. Every write path has
  // upheld it since, so a full-table pass per boot is wasted work.
  { id: "backfill-agent-reply-content", run: backfillAgentReplyContent },
];

/**
 * The migrations that were tracked by counting in `PRAGMA user_version`
 * before `schema_migrations` existed, in their original order. A database
 * with user_version = n had applied the first n. Frozen: never extend it.
 */
const USER_VERSION_MIGRATION_IDS = [
  "settle-server-agent-tasks",
  "backfill-agent-reply-content",
] as const;

async function readUserVersion(): Promise<number> {
  const result = await client.execute("PRAGMA user_version;");
  const value = Number(getRows(result)[0]?.user_version ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * One-time hand-over from the `user_version` counter: while `schema_migrations`
 * is still empty, records the first `user_version` legacy migrations as
 * applied. From then on user_version is never read again, so another tool
 * setting it cannot make a migration be skipped. A value above the legacy
 * count was not written by OpenHorn and is ignored (the legacy migrations are
 * idempotent, so re-running them is safe).
 */
async function adoptUserVersionRecords(): Promise<void> {
  const recorded = await client.execute(`SELECT COUNT(*) AS n FROM schema_migrations;`);
  if (Number(getRows(recorded)[0]?.n ?? 0) > 0) return;
  const userVersion = await readUserVersion();
  if (userVersion < 1 || userVersion > USER_VERSION_MIGRATION_IDS.length) return;
  const now = Math.floor(Date.now() / 1000);
  await client.batch(
    USER_VERSION_MIGRATION_IDS.slice(0, userVersion).map((id) => ({
      sql: `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?);`,
      args: [id, now],
    })),
    "write",
  );
}

async function applyOneTimeMigrations(backup: MigrationBackup): Promise<void> {
  await adoptUserVersionRecords();
  const recorded = await client.execute(`SELECT id FROM schema_migrations;`);
  const applied = new Set(getRows(recorded).map((row) => String(row.id)));
  const pending = ONE_TIME_MIGRATIONS.filter((migration) => !applied.has(migration.id));
  if (pending.length === 0) return;

  await backup.ensure(`one-time migrations (${pending.map((m) => m.id).join(", ")})`);
  for (const migration of pending) {
    await migration.run();
    await client.execute({
      sql: `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?);`,
      args: [migration.id, Math.floor(Date.now() / 1000)],
    });
  }
}

/**
 * Applies the one-time migrations this database has not recorded yet. A
 * migration that throws is not recorded, so it is retried on next boot.
 * `backup` is where to snapshot first when any are pending (none by default).
 * Exported for tests; the server runs them through bootstrapDatabase.
 */
export async function runOneTimeMigrations(
  backup: MigrationBackupTarget | null = null,
): Promise<void> {
  await applyOneTimeMigrations(new MigrationBackup(backup, true));
}
