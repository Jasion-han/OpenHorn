import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  apiKey: text("api_key").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const channelModels = sqliteTable("channel_models", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id),
  modelId: text("model_id").notNull(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  channelId: text("channel_id").references(() => channels.id),
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  conversationId: text("conversation_id").references(() => conversations.id),
  channelId: text("channel_id").references(() => channels.id),
  modelId: text("model_id"),
  title: text("title").notNull(),
  status: text("status").default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  conversationId: text("conversation_id").references(() => conversations.id),
  channelId: text("channel_id").references(() => channels.id),
  modelId: text("model_id"),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  attachments: text("attachments"),
  status: text("status").notNull().default("draft"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  phase: text("phase").notNull(),
  status: text("status").notNull().default("pending"),
  summary: text("summary"),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const agentPlanSteps = sqliteTable("agent_plan_steps", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id),
  orderIndex: integer("order_index").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const agentTaskEvents = sqliteTable("agent_task_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id),
  type: text("type").notNull(),
  content: text("content"),
  toolName: text("tool_name"),
  toolInput: text("tool_input"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const agentApprovalRequests = sqliteTable("agent_approval_requests", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id),
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
});

export const agentArtifacts = sqliteTable("agent_artifacts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: text("config").notNull(),
  isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").references(() => conversations.id),
  sessionId: text("session_id").references(() => agentSessions.id),
  messageId: text("message_id").references(() => messages.id),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const agentEvents = sqliteTable("agent_events", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id),
  type: text("type").notNull(),
  content: text("content"),
  toolName: text("tool_name"),
  toolInput: text("tool_input"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
