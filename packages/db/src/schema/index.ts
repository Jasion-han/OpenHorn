import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  apiKey: text('api_key').notNull(),
  baseUrl: text('base_url'),
  model: text('model'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const channelModels = sqliteTable('channel_models', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  channelId: text('channel_id').references(() => channels.id),
  modelId: text('model_id'),
  title: text('title').notNull(),
  systemPrompt: text('system_prompt'),
  contextLength: integer('context_length').default(4096),
  defaultMode: text('default_mode').default('agent'),
  lastMode: text('last_mode').default('agent'),
  isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
  forceWebSearch: integer('force_web_search', { mode: 'boolean' }).default(false),
  runStatus: text('run_status'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  model: text('model'),
  mode: text('mode').default('chat'),
  attachments: text('attachments'),
  agentRun: text('agent_run'),
  liveMetadata: text('live_metadata'),
  citations: text('citations'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  channelId: text('channel_id').references(() => channels.id),
  modelId: text('model_id'),
  title: text('title').notNull(),
  status: text('status').default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config').notNull(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').references(() => conversations.id),
  sessionId: text('session_id').references(() => agentSessions.id),
  messageId: text('message_id').references(() => messages.id),
  fileName: text('file_name').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  fileSize: integer('file_size').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentEvents = sqliteTable('agent_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => agentSessions.id),
  type: text('type').notNull(),
  content: text('content'),
  toolName: text('tool_name'),
  toolInput: text('tool_input'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  key: text('key').notNull(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
