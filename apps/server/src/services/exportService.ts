/**
 * Data export service — produces a .openhorn-backup.zip for self-migration
 * or a DTI-format JSON for cross-platform interop.
 *
 * Security invariant: API keys, JWT secrets, and encryption keys are NEVER
 * included in any export format.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

import {
  attachments,
  channelModels,
  channels,
  conversations,
  libraryDocuments,
  libraryQuestions,
  mcpServers,
  messages,
  projects,
  reviewWorkspaces,
  savedArtifacts,
  savedArtifactVersions,
  scheduledTasks,
  settings,
  taskRecipes,
  taskRecipeVersions,
} from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { isSafeBackupSetting, sanitizeBackupEndpoint, sanitizeBackupMcp } from "./backupSanitizer";

export const EXPORT_FORMAT_VERSION = "1.3.0";

export interface ExportManifest {
  formatVersion: string;
  exportedAt: string;
  appVersion: string;
  attachmentFiles?: {
    included: number;
    missing: Array<{
      id: string;
      fileName: string;
      reason: "not_on_server" | "not_found" | "not_file";
    }>;
  };
  configuration?: { mcpRequiresSetup: string[]; omittedSettings: number };
  contents: {
    conversations: number;
    messages: number;
    attachments: number;
    channels: number;
    projects: number;
    mcpServers: number;
    scheduledTasks: number;
    settings: number;
    recipes?: number;
    recipeVersions?: number;
    artifacts?: number;
    artifactVersions?: number;
    reviewWorkspaces?: number;
    libraryDocuments?: number;
    libraryQuestions?: number;
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
  // LibSQL batch executes these related SELECTs in one transaction. Independent
  // reads can mix a parent version from before an append with its later history.
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
    recipeRows,
    recipeVersionRows,
    artifactRows,
    artifactVersionRows,
    reviewRows,
    libraryRows,
    libraryQuestionRows,
  ] = await db.batch([
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
    db.select().from(taskRecipes).where(eq(taskRecipes.userId, userId)),
    db
      .select()
      .from(taskRecipeVersions)
      .innerJoin(taskRecipes, eq(taskRecipeVersions.recipeId, taskRecipes.id))
      .where(eq(taskRecipes.userId, userId)),
    db.select().from(savedArtifacts).where(eq(savedArtifacts.userId, userId)),
    db
      .select()
      .from(savedArtifactVersions)
      .innerJoin(savedArtifacts, eq(savedArtifactVersions.artifactId, savedArtifacts.id))
      .where(eq(savedArtifacts.userId, userId)),
    db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.userId, userId)),
    db.select().from(libraryDocuments).where(eq(libraryDocuments.userId, userId)),
    db.select().from(libraryQuestions).where(eq(libraryQuestions.userId, userId)),
  ]);

  return {
    conversations: convRows,
    messages: msgRows.map((r) => r.messages),
    attachments: attachRows.map((r) => r.attachments),
    channels: channelRows.map((row) => ({
      ...stripApiKey(row),
      baseUrl: sanitizeBackupEndpoint(row.baseUrl),
    })),
    channelModels: modelRows.map((r) => r.channel_models),
    projects: projectRows,
    mcpServers: mcpRows.map(sanitizeBackupMcp),
    scheduledTasks: taskRows,
    settings: settingRows.filter(isSafeBackupSetting),
    omittedSettings: settingRows.filter((row) => !isSafeBackupSetting(row)).length,
    recipes: recipeRows,
    recipeVersions: recipeVersionRows.map((row) => row.task_recipe_versions),
    artifacts: artifactRows,
    artifactVersions: artifactVersionRows.map((row) => row.saved_artifact_versions),
    reviewWorkspaces: reviewRows,
    libraryDocuments: libraryRows.map(
      ({
        indexToken: _token,
        leaseUntil: _lease,
        textContent: _text,
        chunkCount: _chunks,
        status: _status,
        errorCode: _error,
        ...row
      }) => row,
    ),
    libraryQuestions: libraryQuestionRows,
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

  const included: Array<{ id: string; localPath: string; entryName: string }> = [];
  const missing: NonNullable<ExportManifest["attachmentFiles"]>["missing"] = [];
  for (const att of data.attachments) {
    const localPath = resolveAttachmentPath(att.filePath);
    if (!localPath) {
      missing.push({ id: att.id, fileName: att.fileName, reason: "not_on_server" });
      continue;
    }
    try {
      const info = await stat(localPath);
      if (!info.isFile()) {
        missing.push({ id: att.id, fileName: att.fileName, reason: "not_file" });
        continue;
      }
      included.push({
        id: att.id,
        localPath,
        entryName: `attachments/${att.id}${path.extname(att.fileName || "")}`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push({ id: att.id, fileName: att.fileName, reason: "not_found" });
    }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `openhorn-backup-${timestamp}-${randomUUID()}.zip`;
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);
  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: process.env.APP_VERSION || "dev",
    attachmentFiles: { included: included.length, missing },
    configuration: {
      mcpRequiresSetup: data.mcpServers.map((row) => row.id),
      omittedSettings: data.omittedSettings,
    },
    contents: {
      conversations: data.conversations.length,
      messages: data.messages.length,
      attachments: data.attachments.length,
      channels: data.channels.length,
      projects: data.projects.length,
      mcpServers: data.mcpServers.length,
      scheduledTasks: data.scheduledTasks.length,
      settings: data.settings.length,
      recipes: data.recipes.length,
      recipeVersions: data.recipeVersions.length,
      artifacts: data.artifacts.length,
      artifactVersions: data.artifactVersions.length,
      reviewWorkspaces: data.reviewWorkspaces.length,
      libraryDocuments: data.libraryDocuments.length,
      libraryQuestions: data.libraryQuestions.length,
    },
  };
  const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  // A source disappearing after preflight must fail, never yield a partial
  // backup reported as successful. pipeline installs both streams' handlers
  // before append/finalize and rejects output errors as well as ZIP errors.
  archive.on("warning", (error) => archive.destroy(error));
  const completed = pipeline(archive, output);
  try {
    onProgress?.({ phase: "metadata", current: 0, total: data.attachments.length + 10 });
    const entries: Record<string, unknown> = {
      "manifest.json": manifest,
      "conversations.json": data.conversations,
      "messages.json": data.messages,
      "attachments.json": data.attachments.map((row) => ({ ...row, filePath: "" })),
      "channels.json": data.channels,
      "channel-models.json": data.channelModels,
      "projects.json": data.projects,
      "mcp-servers.json": data.mcpServers,
      "scheduled-tasks.json": data.scheduledTasks,
      "settings.json": data.settings,
      "task-recipes.json": data.recipes,
      "task-recipe-versions.json": data.recipeVersions,
      "saved-artifacts.json": data.artifacts,
      "saved-artifact-versions.json": data.artifactVersions,
      "review-workspaces.json": data.reviewWorkspaces,
      "library-documents.json": data.libraryDocuments,
      "library-questions.json": data.libraryQuestions,
    };
    for (const [name, value] of Object.entries(entries))
      archive.append(JSON.stringify(value, null, 2), { name });
    let current = 0;
    onProgress?.({ phase: "attachments", current, total: included.length });
    for (const file of included) {
      archive.file(file.localPath, { name: file.entryName });
      onProgress?.({ phase: "attachments", current: ++current, total: included.length });
    }
    await Promise.all([completed, archive.finalize()]);
    return { filePath, manifest };
  } catch (error) {
    archive.destroy();
    output.destroy();
    await completed.catch(() => {});
    await rm(filePath, { force: true });
    throw error;
  }
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
  // local: is metadata-only, not a server path. Reading its suffix could expose
  // an unrelated server file with the same name.
  if (filePath.startsWith("local:")) return null;
  if (filePath.startsWith("uploaded:")) {
    const uploadsDir = path.resolve(
      process.env.OPENHORN_DATA_DIR || path.join(process.cwd(), "data"),
      "uploads",
    );
    const resolved = path.resolve(uploadsDir, filePath.slice("uploaded:".length));
    return resolved.startsWith(`${uploadsDir}${path.sep}`) ? resolved : null;
  }
  return path.isAbsolute(filePath) ? filePath : null;
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
    Buffer.byteLength(JSON.stringify(data.libraryDocuments), "utf8") +
    Buffer.byteLength(JSON.stringify(data.libraryQuestions), "utf8") +
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
