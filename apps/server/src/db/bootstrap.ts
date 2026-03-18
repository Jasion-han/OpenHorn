import type { ResultSet, Row } from "@libsql/client";
import { client } from "./index";

const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);`,

  `CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
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
    enabled INTEGER DEFAULT 1,
    is_default INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id)
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
	    created_at INTEGER NOT NULL,
	    updated_at INTEGER NOT NULL,
	    FOREIGN KEY (user_id) REFERENCES users(id),
	    FOREIGN KEY (channel_id) REFERENCES channels(id)
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
	    created_at INTEGER NOT NULL,
	    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
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
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
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
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id),
    FOREIGN KEY (message_id) REFERENCES messages(id)
  );`,

  `CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
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
];

function getRows(result: ResultSet): Row[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function hasColumnNamed(rows: Row[], columnName: string): boolean {
  return rows.some((row) => typeof row.name === "string" && row.name === columnName);
}

function getColumnDefaultValue(rows: Row[], columnName: string): string | null {
  const row = rows.find((item) => typeof item.name === "string" && item.name === columnName);
  const raw = row?.dflt_value;
  if (raw == null) return null;
  return String(raw).trim().replace(/^['"]|['"]$/g, "");
}

async function ensureConversationModelIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const hasColumn = hasColumnNamed(rows, "model_id");
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN model_id TEXT;`);
  }
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

async function ensureConversationForceWebSearchEnabledByDefault(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = getRows(result);
  const defaultValue = getColumnDefaultValue(rows, "force_web_search");
  if (defaultValue === "1") {
    return;
  }

  await client.execute(`PRAGMA foreign_keys=OFF;`);
  try {
    await client.execute(`BEGIN;`);
    await client.execute(`CREATE TABLE conversations__migrated (
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );`);
    await client.execute(`INSERT INTO conversations__migrated (
      id,
      user_id,
      channel_id,
      model_id,
      title,
      system_prompt,
      context_length,
      default_mode,
      last_mode,
      is_pinned,
      force_web_search,
      run_status,
      workspace_id,
      created_at,
      updated_at
    )
    SELECT
      id,
      user_id,
      channel_id,
      model_id,
      title,
      system_prompt,
      COALESCE(context_length, 4096),
      COALESCE(default_mode, 'agent'),
      COALESCE(last_mode, 'agent'),
      COALESCE(is_pinned, 0),
      1,
      run_status,
      workspace_id,
      created_at,
      updated_at
    FROM conversations;`);
    await client.execute(`DROP TABLE conversations;`);
    await client.execute(`ALTER TABLE conversations__migrated RENAME TO conversations;`);
    await client.execute(`COMMIT;`);
  } catch (error) {
    await client.execute(`ROLLBACK;`);
    throw error;
  } finally {
    await client.execute(`PRAGMA foreign_keys=ON;`);
  }
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
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id)
    );`);
  }
}

export async function bootstrapDatabase(): Promise<void> {
  await client.execute("PRAGMA foreign_keys=ON;");

  for (const stmt of SCHEMA_DDL) {
    await client.execute(stmt);
  }

  // Backward compatible alter for databases created before model_id existed.
  await ensureConversationModelIdColumn();
  await ensureConversationDefaultModeColumn();
  await ensureConversationLastModeColumn();
  await ensureConversationForceWebSearchColumn();
  await ensureConversationRunStatusColumn();
  await ensureConversationWorkspaceIdColumn();
  await ensureConversationForceWebSearchEnabledByDefault();
  await ensureMessageModeColumn();
  await ensureMessageAgentRunColumn();
  await ensureMessageWorkspaceIdColumn();
  await ensureMessageContextPathsColumn();
  await ensureMessageLiveMetadataColumn();
  await ensureMessageCitationsColumn();
  await ensureMcpServerUserIdColumn();
  await ensureAgentEventsTable();
  await ensureAgentSessionModelIdColumn();
  await ensureAgentSessionConversationIdColumn();
  await ensureAttachmentsSessionIdColumn();
}
