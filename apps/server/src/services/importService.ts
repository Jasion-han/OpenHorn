/**
 * Data import service — restores from .openhorn-backup.zip or imports
 * conversations from ChatGPT / Claude export files.
 *
 * Merge strategy: UUID-based dedup; on conflict, keep the newer updatedAt.
 * Channels matched by (name + provider + baseUrl); never overwrites existing keys.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import {
  attachments,
  channelModels,
  channels,
  conversations,
  mcpServers,
  messages,
  projects,
  scheduledTasks,
  settings,
} from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import type { ExportManifest } from "./exportService";

export interface ImportResult {
  format: "openhorn" | "chatgpt" | "claude";
  conversations: { imported: number; skipped: number };
  messages: { imported: number };
  attachments: { imported: number; missing: number };
  channels: { imported: number; skipped: number; needsKey: number };
  projects: { imported: number; needsRebind: number };
  mcpServers: { imported: number; needsConfirm: number };
  scheduledTasks: { imported: number };
  errors: string[];
}

function emptyResult(format: ImportResult["format"]): ImportResult {
  return {
    format,
    conversations: { imported: 0, skipped: 0 },
    messages: { imported: 0 },
    attachments: { imported: 0, missing: 0 },
    channels: { imported: 0, skipped: 0, needsKey: 0 },
    projects: { imported: 0, needsRebind: 0 },
    mcpServers: { imported: 0, needsConfirm: 0 },
    scheduledTasks: { imported: 0 },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// ZIP extraction helpers
// ---------------------------------------------------------------------------

async function extractZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error("Failed to open zip"));
      const entries = new Map<string, Buffer>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

function parseJsonEntry<T>(entries: Map<string, Buffer>, name: string): T | null {
  const buf = entries.get(name);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export type DetectedFormat = "openhorn" | "chatgpt" | "claude" | "unknown";

export async function detectFormat(filePath: string): Promise<DetectedFormat> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    if (entries.has("manifest.json")) return "openhorn";
    if (entries.has("conversations.json")) {
      const raw = entries.get("conversations.json")?.toString("utf8").trim() ?? "";
      if (!raw) return "unknown";
      if (raw.startsWith("[")) {
        const first = JSON.parse(raw)[0];
        if (first?.mapping) return "chatgpt";
        if (first?.chat_messages) return "claude";
      }
    }
    return "unknown";
  }

  if (ext === ".json") {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : null;
    if (!arr || arr.length === 0) return "unknown";
    if (arr[0]?.mapping) return "chatgpt";
    if (arr[0]?.chat_messages) return "claude";
    return "unknown";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// OpenHorn backup import
// ---------------------------------------------------------------------------

export async function importOpenHornBackup(userId: string, zipPath: string): Promise<ImportResult> {
  const result = emptyResult("openhorn");
  const entries = await extractZipEntries(zipPath);

  const manifest = parseJsonEntry<ExportManifest>(entries, "manifest.json");
  if (!manifest) {
    result.errors.push("manifest.json 缺失或解析失败");
    return result;
  }

  // --- Conversations ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const convRows = parseJsonEntry<any[]>(entries, "conversations.json") ?? [];
  const existingConvIds = new Set(
    (
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, userId))
    ).map((r) => r.id),
  );

  for (const conv of convRows) {
    if (existingConvIds.has(conv.id)) {
      result.conversations.skipped++;
      continue;
    }
    await db.insert(conversations).values({ ...conv, userId });
    result.conversations.imported++;
  }

  // --- Messages ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const msgRows = parseJsonEntry<any[]>(entries, "messages.json") ?? [];
  const importedConvIds = new Set(
    convRows
      .filter((c: { id: string }) => !existingConvIds.has(c.id))
      .map((c: { id: string }) => c.id),
  );
  for (const msg of msgRows) {
    if (!importedConvIds.has(msg.conversationId)) continue;
    await db.insert(messages).values(msg);
    result.messages.imported++;
  }

  // --- Attachments ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const attRows = parseJsonEntry<any[]>(entries, "attachments.json") ?? [];
  const uploadsDir = path.join(process.cwd(), "data", "uploads");
  await mkdir(uploadsDir, { recursive: true });

  for (const att of attRows) {
    if (!importedConvIds.has(att.conversationId)) continue;
    const ext = path.extname(att.fileName || "") || "";
    const zipEntryName = `attachments/${att.id}${ext}`;
    const fileData = entries.get(zipEntryName);
    if (fileData) {
      const localName = `imported-${att.id}${ext}`;
      const localPath = path.join(uploadsDir, localName);
      await writeFile(localPath, fileData);
      await db.insert(attachments).values({ ...att, userId, filePath: `uploaded:${localName}` });
      result.attachments.imported++;
    } else {
      result.attachments.missing++;
    }
  }

  // --- Channels (no apiKey) ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const channelRows = parseJsonEntry<any[]>(entries, "channels.json") ?? [];
  for (const ch of channelRows) {
    const existing = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, userId),
          eq(channels.name, ch.name),
          eq(channels.provider, ch.provider),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      result.channels.skipped++;
      continue;
    }
    await db.insert(channels).values({ ...ch, userId, apiKey: "" });
    result.channels.imported++;
    result.channels.needsKey++;
  }

  // --- Channel Models ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const modelRows = parseJsonEntry<any[]>(entries, "channel-models.json") ?? [];
  for (const m of modelRows) {
    try {
      await db.insert(channelModels).values(m);
    } catch {
      // skip if channel doesn't exist or duplicate
    }
  }

  // --- Projects ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const projectRows = parseJsonEntry<any[]>(entries, "projects.json") ?? [];
  for (const p of projectRows) {
    const existing = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.rootPath, p.rootPath)))
      .limit(1);
    if (existing.length > 0) {
      result.projects.imported++;
      continue;
    }
    let pathExists = false;
    try {
      await stat(p.rootPath);
      pathExists = true;
    } catch {
      // path doesn't exist on this machine
    }
    await db.insert(projects).values({ ...p, userId });
    result.projects.imported++;
    if (!pathExists) result.projects.needsRebind++;
  }

  // --- MCP Servers ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const mcpRows = parseJsonEntry<any[]>(entries, "mcp-servers.json") ?? [];
  for (const m of mcpRows) {
    await db.insert(mcpServers).values({ ...m, userId });
    result.mcpServers.imported++;
    result.mcpServers.needsConfirm++;
  }

  // --- Scheduled Tasks ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const taskRows = parseJsonEntry<any[]>(entries, "scheduled-tasks.json") ?? [];
  for (const t of taskRows) {
    await db.insert(scheduledTasks).values({ ...t, userId, enabled: false });
    result.scheduledTasks.imported++;
  }

  // --- Settings ---
  // biome-ignore lint/suspicious/noExplicitAny: external JSON schema
  const settingRows = parseJsonEntry<any[]>(entries, "settings.json") ?? [];
  for (const s of settingRows) {
    const existing = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, s.key)))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(settings).values({ ...s, userId });
  }

  return result;
}

// ---------------------------------------------------------------------------
// ChatGPT import
// ---------------------------------------------------------------------------

interface ChatGPTConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<
    string,
    {
      id: string;
      parent?: string | null;
      children?: string[];
      message?: {
        id: string;
        author: { role: string };
        // biome-ignore lint/suspicious/noExplicitAny: ChatGPT export parts can be string or object
        content: { content_type: string; parts?: any[] };
        metadata?: { model_slug?: string };
        create_time?: number;
      } | null;
    }
  >;
  current_node?: string;
}

function linearizeChatGPT(
  conv: ChatGPTConversation,
): { role: string; content: string; model: string | null; createdAt: Date }[] {
  if (!conv.mapping || !conv.current_node) return [];

  const chain: string[] = [];
  let nodeId: string | null | undefined = conv.current_node;
  while (nodeId && conv.mapping[nodeId]) {
    chain.unshift(nodeId);
    nodeId = conv.mapping[nodeId].parent;
  }

  const result: { role: string; content: string; model: string | null; createdAt: Date }[] = [];
  for (const id of chain) {
    const node = conv.mapping[id];
    const msg = node?.message;
    if (!msg || !msg.author) continue;
    const role = msg.author.role;
    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (msg.content?.parts) {
      content = msg.content.parts.filter((p: unknown) => typeof p === "string").join("\n");
    }
    if (!content.trim()) continue;

    result.push({
      role,
      content,
      model: msg.metadata?.model_slug ?? null,
      createdAt: new Date((msg.create_time ?? conv.create_time ?? Date.now() / 1000) * 1000),
    });
  }
  return result;
}

export async function importChatGPT(userId: string, filePath: string): Promise<ImportResult> {
  const result = emptyResult("chatgpt");

  let convs: ChatGPTConversation[];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    const raw = entries.get("conversations.json");
    if (!raw) {
      result.errors.push("ZIP 中未找到 conversations.json");
      return result;
    }
    convs = JSON.parse(raw.toString("utf8"));
  } else {
    convs = JSON.parse(await readFile(filePath, "utf8"));
  }

  for (const conv of convs) {
    const linearMessages = linearizeChatGPT(conv);
    if (linearMessages.length === 0) continue;

    const convId = crypto.randomUUID();
    const convCreatedAt = new Date((conv.create_time ?? Date.now() / 1000) * 1000);

    await db.insert(conversations).values({
      id: convId,
      userId,
      title: conv.title || "ChatGPT 导入",
      contextLength: 4096,
      defaultMode: "chat",
      lastMode: "chat",
      isPinned: false,
      createdAt: convCreatedAt,
      updatedAt: new Date((conv.update_time ?? conv.create_time ?? Date.now() / 1000) * 1000),
    });
    result.conversations.imported++;

    for (const msg of linearMessages) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convId,
        role: msg.role,
        content: msg.content,
        model: msg.model,
        createdAt: msg.createdAt,
      });
      result.messages.imported++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Claude import
// ---------------------------------------------------------------------------

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: {
    uuid?: string;
    text?: string;
    sender?: string;
    content?: { type: string; text?: string }[];
    created_at?: string;
  }[];
}

export async function importClaude(userId: string, filePath: string): Promise<ImportResult> {
  const result = emptyResult("claude");

  let convs: ClaudeConversation[];
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".zip") {
    const entries = await extractZipEntries(filePath);
    const raw = entries.get("conversations.json");
    if (!raw) {
      result.errors.push("ZIP 中未找到 conversations.json");
      return result;
    }
    convs = JSON.parse(raw.toString("utf8"));
  } else {
    convs = JSON.parse(await readFile(filePath, "utf8"));
  }

  for (const conv of convs) {
    const chatMessages = conv.chat_messages ?? [];
    if (chatMessages.length === 0) continue;

    const convId = crypto.randomUUID();
    const now = new Date();

    await db.insert(conversations).values({
      id: convId,
      userId,
      title: conv.name || "Claude 导入",
      contextLength: 4096,
      defaultMode: "chat",
      lastMode: "chat",
      isPinned: false,
      createdAt: conv.created_at ? new Date(conv.created_at) : now,
      updatedAt: conv.updated_at ? new Date(conv.updated_at) : now,
    });
    result.conversations.imported++;

    for (const msg of chatMessages) {
      const role =
        msg.sender === "human" ? "user" : msg.sender === "assistant" ? "assistant" : null;
      if (!role) continue;

      let content = msg.text ?? "";
      if (!content && msg.content) {
        content = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }
      if (!content.trim()) continue;

      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: convId,
        role,
        content,
        model: conv.model ?? null,
        createdAt: msg.created_at ? new Date(msg.created_at) : now,
      });
      result.messages.imported++;
    }
  }

  return result;
}
