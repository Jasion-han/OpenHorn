import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull(),
  passwordHash: text("password_hash"),
  tokenVersion: integer("token_version").notNull().default(0),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const sessions = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const accounts = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    issuer: text("issuer"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    protocol: text("protocol").notNull().default("openai"),
    apiKey: text("api_key").notNull(),
    baseUrl: text("base_url"),
    model: text("model"),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    isDefault: integer("is_default", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("channels_user_idx").on(table.userId)],
);

export const channelModels = sqliteTable(
  "channel_models",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Null selects verified model metadata or the conservative fallback. */
    contextWindow: integer("context_window"),
    /** Server-discovered model limits and provenance, normalized at runtime. */
    contextMetadata: text("context_metadata"),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    isDefault: integer("is_default", { mode: "boolean" }).default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("channel_models_channel_idx").on(table.channelId)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    modelId: text("model_id"),
    title: text("title").notNull(),
    systemPrompt: text("system_prompt"),
    contextLength: integer("context_length").default(4096),
    defaultMode: text("default_mode").default("agent"),
    lastMode: text("last_mode").default("agent"),
    isPinned: integer("is_pinned", { mode: "boolean" }).default(false),
    forceWebSearch: integer("force_web_search", { mode: "boolean" }).default(true),
    runStatus: text("run_status"),
    workspaceId: text("workspace_id"),
    // Set when the conversation belongs to a scheduled task run. Non-null rows are
    // hidden from the user's chat list (they show under the task group instead).
    scheduledTaskId: text("scheduled_task_id"),
    // Sidebar project (a local folder) the conversation is filed under. Null =
    // plain chat list. No FK: the column is added by ALTER on existing databases
    // and SQLite cannot attach constraints that way; projectService nulls it on
    // project delete instead.
    projectId: text("project_id"),
    summary: text("summary"),
    keyFacts: text("key_facts"),
    lastSummarizedAt: integer("last_summarized_at", { mode: "timestamp" }),
    // Import provenance: source id (`claude-code`, `codex`, `file`, ...) and
    // when it was imported. Null for conversations created inside OpenHorn.
    importedFrom: text("imported_from"),
    importedAt: integer("imported_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("conversations_user_idx").on(table.userId),
    index("conversations_channel_idx").on(table.channelId),
    index("conversations_project_idx").on(table.projectId),
  ],
);

/**
 * A "project" is a local folder the user added to the sidebar. Conversations
 * filed under it run their agent turns with the folder as the sidecar workspace
 * root (cwd), and the sidebar groups them under the project.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Absolute, canonical folder path picked through the desktop folder dialog. */
    rootPath: text("root_path").notNull(),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("projects_user_idx").on(table.userId),
    uniqueIndex("projects_user_root_path_idx").on(table.userId, table.rootPath),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    model: text("model"),
    mode: text("mode").default("chat"),
    attachments: text("attachments"),
    agentRun: text("agent_run"),
    workspaceId: text("workspace_id"),
    contextPaths: text("context_paths"),
    liveMetadata: text("live_metadata"),
    citations: text("citations"),
    /** Bounded provider-specific continuation state, isolated by endpoint/model. */
    providerState: text("provider_state"),
    /** Invalidates prepared sidecar Chat completions when another attempt starts. */
    completionVersion: text("completion_version"),
    /** JSON: { promptTokens, completionTokens, totalTokens }. Null when the provider reported none. */
    usage: text("usage"),
    /**
     * Why the reply ended early: "stopped" (the user pressed Stop and the reply
     * was kept as far as it got). Null = ran to completion / predates the column.
     * Written through shared `assistantFinishReason`. See shared MessageFinishReason.
     */
    finishReason: text("finish_reason"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    /**
     * Last time the answer was re-produced (regenerate / edit-and-resend). Null
     * until that happens. Kept separate from createdAt because reads order by
     * createdAt — bumping it would move a re-generated mid-conversation answer to
     * the end of the thread.
     */
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (table) => [index("messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    modelId: text("model_id"),
    title: text("title").notNull(),
    status: text("status").default("active"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_sessions_user_idx").on(table.userId),
    index("agent_sessions_conversation_idx").on(table.conversationId),
    index("agent_sessions_channel_idx").on(table.channelId),
  ],
);

export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    modelId: text("model_id"),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    attachments: text("attachments"),
    complexity: text("complexity").notNull().default("deep"),
    uxMode: text("ux_mode").notNull().default("full"),
    requiresPlanApproval: integer("requires_plan_approval", { mode: "boolean" })
      .notNull()
      .default(true),
    autoStart: integer("auto_start", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("draft"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_tasks_user_idx").on(table.userId),
    index("agent_tasks_conversation_idx").on(table.conversationId),
    index("agent_tasks_channel_idx").on(table.channelId),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    status: text("status").notNull().default("pending"),
    summary: text("summary"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("agent_runs_task_idx").on(table.taskId)],
);

export const agentPlanSteps = sqliteTable(
  "agent_plan_steps",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_plan_steps_task_idx").on(table.taskId),
    index("agent_plan_steps_run_idx").on(table.runId),
  ],
);

export const agentTaskEvents = sqliteTable(
  "agent_task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    content: text("content"),
    toolName: text("tool_name"),
    toolInput: text("tool_input"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_task_events_task_idx").on(table.taskId),
    index("agent_task_events_run_idx").on(table.runId),
  ],
);

export const agentApprovalRequests = sqliteTable(
  "agent_approval_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title").notNull(),
    description: text("description"),
    payload: text("payload"),
    response: text("response"),
    requestedAt: integer("requested_at", { mode: "timestamp" }).notNull(),
    respondedAt: integer("responded_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_approval_requests_task_idx").on(table.taskId),
    index("agent_approval_requests_run_idx").on(table.runId),
  ],
);

export const agentArtifacts = sqliteTable(
  "agent_artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => agentTasks.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("agent_artifacts_task_idx").on(table.taskId),
    index("agent_artifacts_run_idx").on(table.runId),
  ],
);

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: text("config").notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
    /** Import provenance (source id); null when the user created it by hand. */
    importedFrom: text("imported_from"),
    importedAt: integer("imported_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("mcp_servers_user_idx").on(table.userId)],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    sessionId: text("session_id").references(() => agentSessions.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    filePath: text("file_path").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("attachments_message_idx").on(table.messageId),
    index("attachments_conversation_idx").on(table.conversationId),
    index("attachments_session_idx").on(table.sessionId),
  ],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    content: text("content"),
    toolName: text("tool_name"),
    toolInput: text("tool_input"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("agent_events_session_idx").on(table.sessionId)],
);

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    frequency: text("frequency").notNull(),
    time: text("time").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    notifyOnComplete: integer("notify_on_complete", { mode: "boolean" }).notNull().default(true),
    channelId: text("channel_id"),
    modelId: text("model_id"),
    projectId: text("project_id"),
    recipeSnapshot: text("recipe_snapshot"),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("scheduled_tasks_user_idx").on(table.userId),
    index("scheduled_tasks_next_run_idx").on(table.nextRunAt),
  ],
);

export const scheduledTaskRuns = sqliteTable(
  "scheduled_task_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    conversationId: text("conversation_id"),
    result: text("result"),
    error: text("error"),
    errorCode: text("error_code"),
    ownerToken: text("owner_token"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp" }),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    index("scheduled_task_runs_task_idx").on(table.taskId),
    index("scheduled_task_runs_user_idx").on(table.userId),
    index("scheduled_task_runs_pending_idx").on(table.userId, table.status, table.startedAt),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("settings_user_key_unique").on(table.userId, table.key)],
);

/**
 * One row per import run (local AI-client scan, backup zip, ChatGPT/Claude
 * export, or a desktop-side MCP/skill/credential import reported through
 * `POST /import/records`). `parts` / `errors` are JSON (see `ImportPart` in
 * packages/shared). Deleting a record never undoes the imported data.
 */
export const importRecords = sqliteTable(
  "import_records",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ImportSource: claude-code | codex | gemini | cc-switch | opencode | cursor | claude-desktop | continue | file */
    source: text("source").notNull(),
    /** ImportKind: local | backup | chatgpt | claude-export */
    kind: text("kind").notNull(),
    /** JSON ImportPart[] */
    parts: text("parts").notNull(),
    /** JSON string[] */
    errors: text("errors").notNull(),
    totalImported: integer("total_imported").notNull().default(0),
    totalNeedsAction: integer("total_needs_action").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("import_records_user_created_idx").on(table.userId, table.createdAt)],
);

/**
 * One row per applied one-time data migration (`ONE_TIME_MIGRATIONS` in the
 * server's db/bootstrap.ts), keyed by migration id. Replaced counting in
 * `PRAGMA user_version`, which any external tool can overwrite.
 */
export const schemaMigrations = sqliteTable("schema_migrations", {
  id: text("id").primaryKey(),
  appliedAt: integer("applied_at", { mode: "timestamp" }).notNull(),
});

/** Bounded review datasets and their immutable batch snapshots. */
export const reviewWorkspaces = sqliteTable(
  "review_workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(1),
    data: text("data").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("review_workspaces_user_updated_idx").on(table.userId, table.updatedAt),
    check("review_workspaces_revision_check", sql`${table.revision} > 0`),
  ],
);

/** User recipes and immutable revisions are independent of imported prompts. */
export const taskRecipes = sqliteTable(
  "task_recipes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    spec: text("spec").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("task_recipes_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const taskRecipeVersions = sqliteTable(
  "task_recipe_versions",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => taskRecipes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    spec: text("spec").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("task_recipe_versions_version_unique").on(table.recipeId, table.version)],
);

/** Independent saved copies; source deletion never removes artifact versions. */
export const savedArtifacts = sqliteTable(
  "saved_artifacts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("saved_artifacts_user_updated_idx").on(table.userId, table.updatedAt),
    index("saved_artifacts_project_idx").on(table.projectId),
  ],
);

export const savedArtifactVersions = sqliteTable(
  "saved_artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => savedArtifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    format: text("format", { enum: ["markdown", "html", "openui"] }).notNull(),
    sourceConversationId: text("source_conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    check(
      "saved_artifact_versions_format_check",
      sql`${table.format} IN ('markdown', 'html', 'openui')`,
    ),
    uniqueIndex("saved_artifact_versions_version_unique").on(table.artifactId, table.version),
    index("saved_artifact_versions_source_conversation_idx").on(table.sourceConversationId),
    index("saved_artifact_versions_source_message_idx").on(table.sourceMessageId),
  ],
);

export const libraryDocuments = sqliteTable(
  "library_documents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    fileName: text("file_name").notNull(),
    fileType: text("file_type").notNull(),
    fileSize: integer("file_size").notNull(),
    sha256: text("sha256").notNull(),
    originalBase64: text("original_base64").notNull(),
    textContent: text("text_content").notNull().default(""),
    status: text("status", { enum: ["pending", "indexing", "ready", "failed"] })
      .notNull()
      .default("pending"),
    errorCode: text("error_code"),
    chunkCount: integer("chunk_count").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    indexToken: text("index_token"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("library_documents_identity_unique").on(
      table.userId,
      table.scopeKey,
      table.fileName,
      table.sha256,
    ),
    index("library_documents_user_scope_idx").on(table.userId, table.scopeKey),
    index("library_documents_project_idx").on(table.projectId),
  ],
);
export const libraryChunks = sqliteTable(
  "library_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    heading: text("heading"),
  },
  (table) => [
    uniqueIndex("library_chunks_document_index_unique").on(table.documentId, table.chunkIndex),
  ],
);
export const libraryQuestions = sqliteTable(
  "library_questions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    inputHash: text("input_hash").notNull(),
    scopeKind: text("scope_kind", { enum: ["personal", "project"] }).notNull(),
    // Frozen original scope survives project deletion; projectId is the live owned binding.
    scopeProjectId: text("scope_project_id"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    modelId: text("model_id").notNull(),
    question: text("question").notNull(),
    sources: text("sources").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("library_questions_request_unique").on(table.userId, table.requestId),
    index("library_questions_user_idx").on(table.userId),
    index("library_questions_project_idx").on(table.projectId),
    index("library_questions_conversation_idx").on(table.conversationId),
    index("library_questions_channel_idx").on(table.channelId),
  ],
);

/** Same-archive resume evidence; deleted conversations remove their checkpoints. */
export const backupRestoreConversations = sqliteTable(
  "backup_restore_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    archiveHash: text("archive_hash").notNull(),
    sourceId: text("source_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    attachmentIds: text("attachment_ids").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("backup_restore_conversations_identity_unique").on(
      table.userId,
      table.archiveHash,
      table.sourceId,
    ),
    index("backup_restore_conversations_conversation_idx").on(table.conversationId),
  ],
);
