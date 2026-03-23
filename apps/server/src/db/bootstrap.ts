import type { ResultSet, Row } from "@libsql/client";
import { client } from "./index";

type ForeignKeyExpectation = {
  from: string;
  table: string;
  to: string;
  onDelete: string;
};

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
	    created_at INTEGER NOT NULL,
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
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
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

async function ensureDeleteSemanticsForeignKeys(): Promise<void> {
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

  await client.execute("PRAGMA foreign_keys=OFF;");
  try {
    await client.execute("BEGIN;");

    await client.execute(`CREATE TABLE channel_models__migrated (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );`);
    await client.execute(`INSERT INTO channel_models__migrated
      SELECT id, channel_id, model_id, display_name, enabled, is_default, created_at, updated_at
      FROM channel_models;`);

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
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );`);
    await client.execute(`INSERT INTO conversations__migrated
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
        COALESCE(force_web_search, 1),
        run_status,
        workspace_id,
        created_at,
        updated_at
      FROM conversations;`);

    await client.execute(`CREATE TABLE messages__migrated (
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
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );`);
    await client.execute(`INSERT INTO messages__migrated
      SELECT
        id,
        conversation_id,
        role,
        content,
        model,
        COALESCE(mode, 'chat'),
        attachments,
        agent_run,
        workspace_id,
        context_paths,
        live_metadata,
        citations,
        created_at
      FROM messages;`);

    await client.execute(`CREATE TABLE agent_sessions__migrated (
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
    );`);
    await client.execute(`INSERT INTO agent_sessions__migrated
      SELECT
        id,
        user_id,
        conversation_id,
        channel_id,
        model_id,
        title,
        COALESCE(status, 'active'),
        created_at,
        updated_at
      FROM agent_sessions;`);

    await client.execute(`CREATE TABLE agent_tasks__migrated (
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
    );`);
    await client.execute(`INSERT INTO agent_tasks__migrated
      SELECT
        id,
        user_id,
        conversation_id,
        channel_id,
        model_id,
        title,
        goal,
        attachments,
        COALESCE(complexity, 'deep'),
        COALESCE(ux_mode, 'full'),
        COALESCE(requires_plan_approval, 1),
        COALESCE(auto_start, 0),
        COALESCE(status, 'draft'),
        created_at,
        updated_at
      FROM agent_tasks;`);

    await client.execute(`CREATE TABLE attachments__migrated (
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
    );`);
    await client.execute(`INSERT INTO attachments__migrated
      SELECT
        id,
        conversation_id,
        session_id,
        message_id,
        file_name,
        file_path,
        file_type,
        file_size,
        created_at
      FROM attachments;`);

    await client.execute(`CREATE TABLE agent_events__migrated (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );`);
    await client.execute(`INSERT INTO agent_events__migrated
      SELECT id, session_id, type, content, tool_name, tool_input, created_at
      FROM agent_events;`);

    await client.execute("DROP TABLE channel_models;");
    await client.execute("DROP TABLE attachments;");
    await client.execute("DROP TABLE agent_events;");
    await client.execute("DROP TABLE messages;");
    await client.execute("DROP TABLE agent_sessions;");
    await client.execute("DROP TABLE agent_tasks;");
    await client.execute("DROP TABLE conversations;");

    await client.execute("ALTER TABLE conversations__migrated RENAME TO conversations;");
    await client.execute("ALTER TABLE messages__migrated RENAME TO messages;");
    await client.execute("ALTER TABLE agent_sessions__migrated RENAME TO agent_sessions;");
    await client.execute("ALTER TABLE agent_tasks__migrated RENAME TO agent_tasks;");
    await client.execute("ALTER TABLE attachments__migrated RENAME TO attachments;");
    await client.execute("ALTER TABLE agent_events__migrated RENAME TO agent_events;");
    await client.execute("ALTER TABLE channel_models__migrated RENAME TO channel_models;");

    await client.execute("COMMIT;");
  } catch (error) {
    await client.execute("ROLLBACK;");
    throw error;
  } finally {
    await client.execute("PRAGMA foreign_keys=ON;");
  }
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
  await ensureAgentTaskComplexityColumn();
  await ensureAgentTaskUxModeColumn();
  await ensureAgentTaskRequiresPlanApprovalColumn();
  await ensureAgentTaskAutoStartColumn();
  await ensureAttachmentsSessionIdColumn();
  await ensureDeleteSemanticsForeignKeys();
}
