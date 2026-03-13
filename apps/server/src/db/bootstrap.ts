import { client } from './index';

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
    is_pinned INTEGER DEFAULT 0,
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
    attachments TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );`,

  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    channel_id TEXT,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    message_id TEXT,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
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

async function ensureConversationModelIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('conversations');`);
  const rows = (result as any).rows as Array<Record<string, unknown>> | undefined;
  const hasColumn = (rows || []).some((row) => row.name === 'model_id' || row['name'] === 'model_id');
  if (!hasColumn) {
    await client.execute(`ALTER TABLE conversations ADD COLUMN model_id TEXT;`);
  }
}

async function ensureMcpServerUserIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('mcp_servers');`);
  const rows = (result as any).rows as Array<Record<string, unknown>> | undefined;
  const hasColumn = (rows || []).some((row) => row.name === 'user_id' || row['name'] === 'user_id');
  if (!hasColumn) {
    await client.execute(`ALTER TABLE mcp_servers ADD COLUMN user_id TEXT;`);

    // Best-effort backfill: prefer deriving ownership from workspace_id.
    // If a server isn't bound to a workspace, and there's exactly one user, attach it to that user.
    await client.execute(`
      UPDATE mcp_servers
      SET user_id = (
        SELECT user_id FROM workspaces WHERE workspaces.id = mcp_servers.workspace_id
      )
      WHERE user_id IS NULL AND workspace_id IS NOT NULL;
    `);

    const users = await client.execute(`SELECT id FROM users LIMIT 2;`);
    const userRows = (users as any).rows as Array<{ id?: string }> | undefined;
    if (Array.isArray(userRows) && userRows.length === 1 && userRows[0]?.id) {
      await client.execute(`
        UPDATE mcp_servers
        SET user_id = '${userRows[0].id}'
        WHERE user_id IS NULL;
      `);
    }
  }
}

async function ensureAgentSessionModelIdColumn(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_sessions');`);
  const rows = (result as any).rows as Array<Record<string, unknown>> | undefined;
  const hasColumn = (rows || []).some((row) => row.name === 'model_id');
  if (!hasColumn) {
    await client.execute(`ALTER TABLE agent_sessions ADD COLUMN model_id TEXT;`);
  }
}

async function ensureAgentEventsTable(): Promise<void> {
  const result = await client.execute(`PRAGMA table_info('agent_events');`);
  const rows = (result as any).rows as Array<Record<string, unknown>> | undefined;
  if (!rows || rows.length === 0) {
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
  await client.execute('PRAGMA foreign_keys=ON;');

  for (const stmt of SCHEMA_DDL) {
    await client.execute(stmt);
  }

  // Backward compatible alter for databases created before model_id existed.
  await ensureConversationModelIdColumn();
  await ensureMcpServerUserIdColumn();
  await ensureAgentEventsTable();
  await ensureAgentSessionModelIdColumn();
}
