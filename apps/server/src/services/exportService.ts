/**
 * Data export service — produces a .openhorn-backup.zip for self-migration
 * or a DTI-format JSON for cross-platform interop.
 *
 * Security invariant: API keys, JWT secrets, and encryption keys are NEVER
 * included in any export format.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiver = require("archiver") as (
  format: string,
  options?: object,
) => import("archiver").Archiver;
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
import { eq } from "drizzle-orm";
import { db } from "../db";

export const EXPORT_FORMAT_VERSION = "1.0.0";

export interface ExportManifest {
  formatVersion: string;
  exportedAt: string;
  appVersion: string;
  contents: {
    conversations: number;
    messages: number;
    attachments: number;
    channels: number;
    projects: number;
    mcpServers: number;
    scheduledTasks: number;
    settings: number;
  };
}

interface ExportProgress {
  phase: string;
  current: number;
  total: number;
}

type ProgressCallback = (progress: ExportProgress) => void;

function stripApiKey<T extends Record<string, unknown>>(row: T): Omit<T, "apiKey"> {
  const { apiKey: _, ...rest } = row;
  return rest as Omit<T, "apiKey">;
}

async function collectExportData(userId: string) {
  const [
    convRows,
    msgRows,
    attachRows,
    channelRows,
    modelRows,
    projectRows,
    mcpRows,
    taskRows,
    settingRows,
  ] = await Promise.all([
    db.select().from(conversations).where(eq(conversations.userId, userId)),
    db
      .select()
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.userId, userId)),
    db
      .select()
      .from(attachments)
      .innerJoin(conversations, eq(attachments.conversationId, conversations.id))
      .where(eq(conversations.userId, userId)),
    db.select().from(channels).where(eq(channels.userId, userId)),
    db
      .select()
      .from(channelModels)
      .innerJoin(channels, eq(channelModels.channelId, channels.id))
      .where(eq(channels.userId, userId)),
    db.select().from(projects).where(eq(projects.userId, userId)),
    db.select().from(mcpServers).where(eq(mcpServers.userId, userId)),
    db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, userId)),
    db.select().from(settings).where(eq(settings.userId, userId)),
  ]);

  return {
    conversations: convRows,
    messages: msgRows.map((r) => r.messages),
    attachments: attachRows.map((r) => r.attachments),
    channels: channelRows.map(stripApiKey),
    channelModels: modelRows.map((r) => r.channel_models),
    projects: projectRows,
    mcpServers: mcpRows,
    scheduledTasks: taskRows,
    settings: settingRows,
  };
}

/**
 * Export full backup as a .openhorn-backup.zip.
 * Returns the absolute path of the written file.
 */
export async function exportBackup(
  userId: string,
  outputDir: string,
  onProgress?: ProgressCallback,
): Promise<{ filePath: string; manifest: ExportManifest }> {
  const data = await collectExportData(userId);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `openhorn-backup-${timestamp}.zip`;
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);

  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: process.env.APP_VERSION || "dev",
    contents: {
      conversations: data.conversations.length,
      messages: data.messages.length,
      attachments: data.attachments.length,
      channels: data.channels.length,
      projects: data.projects.length,
      mcpServers: data.mcpServers.length,
      scheduledTasks: data.scheduledTasks.length,
      settings: data.settings.length,
    },
  };

  const output = createWriteStream(filePath);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(output);

  onProgress?.({ phase: "metadata", current: 0, total: data.attachments.length + 5 });

  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  archive.append(JSON.stringify(data.conversations, null, 2), { name: "conversations.json" });
  archive.append(JSON.stringify(data.messages, null, 2), { name: "messages.json" });
  archive.append(JSON.stringify(data.channels, null, 2), { name: "channels.json" });
  archive.append(JSON.stringify(data.channelModels, null, 2), { name: "channel-models.json" });
  archive.append(JSON.stringify(data.projects, null, 2), { name: "projects.json" });
  archive.append(JSON.stringify(data.mcpServers, null, 2), { name: "mcp-servers.json" });
  archive.append(JSON.stringify(data.scheduledTasks, null, 2), { name: "scheduled-tasks.json" });
  archive.append(JSON.stringify(data.settings, null, 2), { name: "settings.json" });

  onProgress?.({ phase: "attachments", current: 0, total: data.attachments.length });

  let attachCount = 0;
  for (const att of data.attachments) {
    const localPath = resolveAttachmentPath(att.filePath);
    if (!localPath) continue;
    try {
      await stat(localPath);
      const ext = path.extname(att.fileName || "") || path.extname(localPath) || "";
      archive.file(localPath, { name: `attachments/${att.id}${ext}` });
      attachCount++;
      onProgress?.({ phase: "attachments", current: attachCount, total: data.attachments.length });
    } catch {
      // file missing on disk — skip silently
    }
  }

  await archive.finalize();
  await new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
  });

  return { filePath, manifest };
}

/**
 * Export conversations in DTI-compatible JSON format for cross-platform use.
 */
export async function exportDTI(userId: string): Promise<object[]> {
  const convRows = await db.select().from(conversations).where(eq(conversations.userId, userId));
  const msgRows = await db
    .select()
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(eq(conversations.userId, userId));

  const msgsByConv = new Map<string, (typeof msgRows)[0]["messages"][]>();
  for (const row of msgRows) {
    const list = msgsByConv.get(row.messages.conversationId) || [];
    list.push(row.messages);
    msgsByConv.set(row.messages.conversationId, list);
  }

  return convRows.map((conv) => {
    const msgs = msgsByConv.get(conv.id) || [];
    msgs.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    return {
      id: conv.id,
      title: conv.title,
      create_time: conv.createdAt?.toISOString(),
      update_time: conv.updatedAt?.toISOString(),
      messages: msgs.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model,
        create_time: m.createdAt?.toISOString(),
      })),
    };
  });
}

function resolveAttachmentPath(filePath: string): string | null {
  if (filePath.startsWith("local:")) {
    return filePath.slice("local:".length);
  }
  if (filePath.startsWith("uploaded:")) {
    const uploadsDir = path.join(process.cwd(), "data", "uploads");
    return path.join(uploadsDir, filePath.slice("uploaded:".length));
  }
  return null;
}

/**
 * Estimate export size in bytes (rough approximation for UI display).
 */
export async function estimateExportSize(userId: string): Promise<{
  conversations: number;
  messages: number;
  attachments: number;
  estimatedBytes: number;
}> {
  const data = await collectExportData(userId);

  let attachmentBytes = 0;
  for (const att of data.attachments) {
    attachmentBytes += att.fileSize ?? 0;
  }

  const jsonBytes =
    JSON.stringify(data.conversations).length +
    JSON.stringify(data.messages).length +
    JSON.stringify(data.channels).length +
    JSON.stringify(data.settings).length;

  return {
    conversations: data.conversations.length,
    messages: data.messages.length,
    attachments: data.attachments.length,
    estimatedBytes: jsonBytes + attachmentBytes,
  };
}
