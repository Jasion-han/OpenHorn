import { expect, test } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attachments,
  backupRestoreConversations,
  channelModels,
  channels,
  conversations,
  importRecords,
  mcpServers,
  messages,
  projects,
  savedArtifacts,
  savedArtifactVersions,
  scheduledTasks,
  settings,
  taskRecipes,
  taskRecipeVersions,
  users,
} from "db";
import { eq } from "drizzle-orm";
import type { FrozenRecipeSnapshot, RecipeSpec } from "shared/types";
import yauzl from "yauzl";
import { client, db } from "../db";
import {
  appendArtifactVersion,
  createArtifact,
  getArtifactDetail,
  listArtifacts,
} from "./artifactService";
import { exportBackup } from "./exportService";
import { getImportRecord } from "./importRecordsService";
import { importOpenHornBackup } from "./importService";
import {
  createRecipe,
  getRecipe,
  listRecipes,
  scheduleRecipe,
  updateRecipe,
} from "./recipeService";

async function seedUser() {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `${id}@test.local`,
    username: "backup-fixture",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}
async function cleanupUser(userId: string) {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  for (const { id } of rows) {
    await db.delete(attachments).where(eq(attachments.conversationId, id));
    await db.delete(messages).where(eq(messages.conversationId, id));
  }
  for (const table of [
    savedArtifacts,
    taskRecipes,
    scheduledTasks,
    conversations,
    channels,
    mcpServers,
    settings,
    importRecords,
    projects,
  ])
    await db.delete(table).where(eq(table.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}
async function readZip(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("ZIP unavailable"));
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("Entry unavailable"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
async function seedConversation(userId: string) {
  const id = crypto.randomUUID();
  await db.insert(conversations).values({
    id,
    userId,
    title: "Backup round trip",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(messages).values({
    id: crypto.randomUUID(),
    conversationId: id,
    role: "user",
    content: "Keep this conversation",
    createdAt: new Date(),
  });
  return id;
}
async function seedAttachment(conversationId: string, filePath: string, fileName = "fixture.txt") {
  const id = crypto.randomUUID();
  await db.insert(attachments).values({
    id,
    conversationId,
    filePath,
    fileName,
    fileType: "text/plain",
    fileSize: 21,
    createdAt: new Date(),
  });
  return id;
}

test("backup: ZIP round-trips uploaded bytes and removes configuration credentials", async () => {
  const userId = await seedUser();
  const destinationUserId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-test-"));
  const previousDataDir = process.env.OPENHORN_DATA_DIR;
  process.env.OPENHORN_DATA_DIR = path.join(dir, "restored");
  try {
    const conversationId = await seedConversation(userId);
    const original = Buffer.from("Original bytes\n中文\0", "utf8");
    const originalPath = path.join(dir, "upload.txt");
    await writeFile(originalPath, original);
    const attachmentId = await seedAttachment(conversationId, originalPath);
    await seedAttachment(conversationId, path.join(dir, "missing.txt"), "missing.txt");
    const localOnly = path.join(dir, "local-only.txt");
    await writeFile(localOnly, "LOCAL_SENTINEL_MUST_NOT_BE_READ");
    await seedAttachment(conversationId, `local:${localOnly}`, "local-only.txt");
    const now = new Date();
    await db.insert(channels).values({
      id: crypto.randomUUID(),
      userId,
      name: "Fixture",
      provider: "openai",
      apiKey: "CHANNEL_SECRET_SENTINEL",
      baseUrl:
        "https://USER_SECRET_SENTINEL:PASSWORD_SECRET_SENTINEL@gateway.example/URL_PATH_SECRET_SENTINEL?key=QUERY_SECRET_SENTINEL#FRAGMENT_SECRET_SENTINEL",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(mcpServers).values({
      id: crypto.randomUUID(),
      userId,
      name: "Fixture MCP",
      type: "stdio",
      config: JSON.stringify({
        command: "npx",
        args: ["ARG_SECRET_SENTINEL", "--password=ARG_FLAG_SECRET_SENTINEL"],
        env: { ANY_NAME: "ENV_SECRET_SENTINEL" },
        headers: { "X-Custom": "HEADER_SECRET_SENTINEL" },
        url: "https://remote.example/PATH_SECRET_SENTINEL?token=MCP_URL_SECRET_SENTINEL",
        arbitrary: { value: "NESTED_SECRET_SENTINEL" },
      }),
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    for (const [key, value] of [
      ["liveSearch.tavilyEnabled", "true"],
      ["liveSearch.tavilyApiKey", "SETTING_SECRET_SENTINEL"],
      ["customSetting", "UNKNOWN_SETTING_SECRET_SENTINEL"],
    ])
      await db
        .insert(settings)
        .values({ id: crypto.randomUUID(), userId, key, value, updatedAt: now });
    const result = await exportBackup(userId, path.join(dir, "export"));
    const entries = await readZip(result.filePath);
    const combined = [...entries.values()].map((value) => value.toString()).join("\n");
    expect(combined.includes("SECRET_SENTINEL")).toBe(false);
    expect(combined.includes("LOCAL_SENTINEL_MUST_NOT_BE_READ")).toBe(false);
    expect(entries.get(`attachments/${attachmentId}.txt`)).toEqual(original);
    expect(JSON.parse(entries.get("attachments.json")?.toString() ?? "[]")).toHaveLength(3);
    const manifest = JSON.parse(entries.get("manifest.json")?.toString() ?? "{}");
    expect(manifest.attachmentFiles.included).toBe(1);
    expect(manifest.attachmentFiles.missing).toHaveLength(2);
    expect(manifest.configuration.omittedSettings).toBe(2);
    const safeMcp = JSON.parse(entries.get("mcp-servers.json")?.toString() ?? "[]");
    expect(safeMcp[0].isEnabled).toBe(false);
    expect(JSON.parse(safeMcp[0].config)).toEqual({ type: "stdio", command: "npx" });
    await cleanupUser(userId);
    const restored = await importOpenHornBackup(destinationUserId, result.filePath);
    expect(restored.conversations.imported).toBe(1);
    expect(restored.messages.imported).toBe(1);
    expect(restored.attachments).toEqual({ imported: 1, missing: 2 });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
    expect(path.isAbsolute(row.filePath)).toBe(true);
    expect(row.filePath.endsWith(".txt")).toBe(true);
    expect(await readFile(row.filePath)).toEqual(original);
    expect(row.filePath.startsWith(path.join(dir, "restored"))).toBe(true);
    const [restoredMcp] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.userId, destinationUserId));
    expect(restoredMcp.isEnabled).toBe(false);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENHORN_DATA_DIR;
    else process.env.OPENHORN_DATA_DIR = previousDataDir;
    await cleanupUser(userId);
    await cleanupUser(destinationUserId);
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup: empty ZIP closes and disappearing source rejects", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-errors-"));
  try {
    const empty = await exportBackup(userId, path.join(dir, "empty"));
    expect((await readZip(empty.filePath)).has("manifest.json")).toBe(true);
    const conversationId = await seedConversation(userId);
    const source = path.join(dir, "source.txt");
    await writeFile(source, "fixture");
    await seedAttachment(conversationId, source);
    let rejected = false;
    try {
      await exportBackup(userId, path.join(dir, "broken"), (progress) => {
        if (progress.phase === "metadata") unlinkSync(source);
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  } finally {
    await cleanupUser(userId);
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup: asynchronous output open failure rejects without an unhandled stream error", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-output-error-"));
  const outputDir = path.join(dir, "export");
  try {
    let rejected = false;
    try {
      await exportBackup(userId, outputDir, (progress) => {
        if (progress.phase === "metadata") rmSync(outputDir, { recursive: true, force: true });
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  } finally {
    await cleanupUser(userId);
    await rm(dir, { recursive: true, force: true });
  }
});

test("workbench backup remaps foreign IDs and natural-key references, preserves all revisions and source-independent copies", async () => {
  const source = await seedUser();
  const destination = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-workbench-backup-"));
  const previousDataDir = process.env.OPENHORN_DATA_DIR;
  process.env.OPENHORN_DATA_DIR = path.join(dir, "restored");
  try {
    const now = new Date();
    const sourceProject = crypto.randomUUID(),
      destinationProject = crypto.randomUUID();
    const sourceChannel = crypto.randomUUID(),
      destinationChannel = crypto.randomUUID();
    const rootPath = path.join(dir, "workspace");
    for (const [id, userId] of [
      [sourceProject, source],
      [destinationProject, destination],
    ]) {
      await db.insert(projects).values({
        id,
        userId,
        name: "Synthetic project",
        rootPath,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const [id, userId] of [
      [sourceChannel, source],
      [destinationChannel, destination],
    ]) {
      await db.insert(channels).values({
        id,
        userId,
        name: "Synthetic channel",
        provider: "openai",
        apiKey: "DO_NOT_EXPORT_WORKBENCH_SECRET",
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(channelModels).values({
      id: crypto.randomUUID(),
      channelId: sourceChannel,
      modelId: "synthetic-model",
      displayName: "Fixture",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const spec: RecipeSpec = {
      title: "First recipe title",
      description: "Initial description",
      promptTemplate: "Report {{company}}",
      parameters: [{ key: "company", label: "Company", type: "text", required: true }],
      requirements: {
        skills: ["fixture-skill"],
        mcpServers: [],
        workspace: true,
        webSearch: false,
      },
      projectId: sourceProject,
      channelId: sourceChannel,
      modelId: "synthetic-model",
      outputFormat: "markdown",
    };
    const recipe = await createRecipe(source, spec);
    await updateRecipe(
      source,
      recipe.id,
      { ...spec, title: "Current recipe title", promptTemplate: "Updated {{company}}" },
      1,
    );
    await scheduleRecipe(source, recipe.id, 1, { company: "Synthetic company" }, "daily", "09:00");
    const conversationId = await seedConversation(source);
    await db
      .update(conversations)
      .set({ projectId: sourceProject, channelId: sourceChannel })
      .where(eq(conversations.id, conversationId));
    const attachmentBytes = Buffer.from("Persistent raw bytes 中文", "utf8");
    const attachmentPath = path.join(dir, "source-upload.txt");
    await writeFile(attachmentPath, attachmentBytes);
    const sourceAttachmentId = await seedAttachment(conversationId, attachmentPath);
    const [sourceUserMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    await db
      .update(attachments)
      .set({ messageId: sourceUserMessage.id })
      .where(eq(attachments.id, sourceAttachmentId));
    await db
      .update(messages)
      .set({ attachments: JSON.stringify([sourceAttachmentId]) })
      .where(eq(messages.id, sourceUserMessage.id));
    const messageId = crypto.randomUUID();
    const original = "  # Whole source\r\n中文 😀\nNo truncation.  ";
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      role: "assistant",
      content: original,
      mode: "chat",
      createdAt: now,
    });
    const first = await createArtifact(source, {
      title: "Versioned report",
      sourceMessageId: messageId,
      projectId: sourceProject,
    });
    await appendArtifactVersion(source, first.artifact.id, {
      expectedVersion: 1,
      content: "<h1>Version two</h1><script>window.fixture=true</script>",
      format: "html",
    });
    const deletedConversation = await seedConversation(source);
    const deletedMessage = crypto.randomUUID();
    await db.insert(messages).values({
      id: deletedMessage,
      conversationId: deletedConversation,
      role: "assistant",
      content: "Independent source copy",
      mode: "chat",
      createdAt: now,
    });
    const independent = await createArtifact(source, {
      title: "Deleted source copy",
      sourceMessageId: deletedMessage,
    });
    await db.delete(conversations).where(eq(conversations.id, deletedConversation));
    const exported = await exportBackup(source, path.join(dir, "export"));
    expect(exported.manifest.contents.recipes).toBe(1);
    expect(exported.manifest.contents.recipeVersions).toBe(2);
    expect(exported.manifest.contents.artifacts).toBe(2);
    expect(exported.manifest.contents.artifactVersions).toBe(3);
    const archive = await readZip(exported.filePath);
    expect(
      [...archive.values()].some((value) =>
        value.toString().includes("DO_NOT_EXPORT_WORKBENCH_SECRET"),
      ),
    ).toBe(false);
    const restored = await importOpenHornBackup(destination, exported.filePath);
    expect(restored.recipes).toEqual({ imported: 1, skipped: 0 });
    expect(restored.artifacts).toEqual({ imported: 2, skipped: 0 });
    expect(restored.conversations.imported).toBe(1);
    expect(restored.messages.imported).toBe(2);
    expect(restored.attachments.imported).toBe(1);

    const [importedRecipe] = await listRecipes(destination);
    expect(importedRecipe.id === recipe.id).toBe(false);
    expect(importedRecipe.spec.projectId).toBe(destinationProject);
    expect(importedRecipe.spec.channelId).toBe(destinationChannel);
    const detail = await getRecipe(destination, importedRecipe.id);
    expect(detail?.versions.map((version) => version.spec.promptTemplate)).toEqual([
      "Updated {{company}}",
      "Report {{company}}",
    ]);
    const [task] = await db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.userId, destination));
    const snapshot = JSON.parse(task.recipeSnapshot ?? "null") as FrozenRecipeSnapshot;
    expect(task.enabled).toBe(false);
    expect(task.projectId).toBe(destinationProject);
    expect(task.channelId).toBe(destinationChannel);
    expect(snapshot.recipeId).toBe(importedRecipe.id);
    expect(snapshot.version).toBe(1);
    expect(snapshot.spec.promptTemplate).toBe("Report {{company}}");
    expect(snapshot.spec.projectId).toBe(destinationProject);
    expect(snapshot.spec.channelId).toBe(destinationChannel);
    expect(snapshot.renderedPrompt).toBe(task.prompt);
    const artifacts = await listArtifacts(destination);
    const importedArtifact = artifacts.find((row) => row.title === "Versioned report");
    expect(importedArtifact?.id === first.artifact.id).toBe(false);
    expect(importedArtifact?.projectId).toBe(destinationProject);
    const versionOne = await getArtifactDetail(destination, importedArtifact?.id ?? "", 1);
    expect(versionOne.version.content).toBe(original);
    expect(versionOne.version.sourceConversationId === conversationId).toBe(false);
    expect(versionOne.version.sourceMessageId === messageId).toBe(false);
    const [mappedConversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, versionOne.version.sourceConversationId ?? ""));
    expect(mappedConversation.userId).toBe(destination);
    const [mappedMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, versionOne.version.sourceMessageId ?? ""));
    expect(mappedMessage.conversationId).toBe(mappedConversation.id);
    const [mappedAttachment] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.conversationId, mappedConversation.id));
    expect(mappedAttachment.id === sourceAttachmentId).toBe(false);
    expect(await readFile(mappedAttachment.filePath)).toEqual(attachmentBytes);
    const [mappedUserMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, mappedAttachment.messageId ?? ""));
    expect(JSON.parse(mappedUserMessage.attachments ?? "null")).toEqual([mappedAttachment.id]);

    const versionTwo = await getArtifactDetail(destination, importedArtifact?.id ?? "");
    expect(versionTwo.version.format).toBe("html");
    expect(versionTwo.version.content).toBe(
      "<h1>Version two</h1><script>window.fixture=true</script>",
    );
    expect(versionTwo.versions).toHaveLength(2);
    const independentCopy = artifacts.find((row) => row.title === "Deleted source copy");
    const independentDetail = await getArtifactDetail(destination, independentCopy?.id ?? "");
    expect(independentDetail.version.content).toBe("Independent source copy");
    expect(independentDetail.version.sourceConversationId).toBe(null);
    expect(independentDetail.version.sourceMessageId).toBe(null);
    expect((await getArtifactDetail(source, first.artifact.id)).artifact.currentVersion).toBe(2);
    expect((await getArtifactDetail(source, independent.artifact.id)).version.content).toBe(
      "Independent source copy",
    );
    const history = await getImportRecord(destination, restored.recordId ?? "");
    expect(history?.parts.find((part) => part.type === "recipes")?.imported).toBe(1);
    expect(history?.parts.find((part) => part.type === "artifacts")?.imported).toBe(2);
    const again = await importOpenHornBackup(destination, exported.filePath);
    expect(again.recipes).toEqual({ imported: 0, skipped: 1 });
    expect(again.artifacts).toEqual({ imported: 0, skipped: 2 });
    expect((await listRecipes(destination)).length).toBe(1);
    expect((await listArtifacts(destination)).length).toBe(2);
    expect(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, destination))).length,
    ).toBe(1);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENHORN_DATA_DIR;
    else process.env.OPENHORN_DATA_DIR = previousDataDir;
    await cleanupUser(source);
    await cleanupUser(destination);
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup uses a consistent SQL snapshot while recipe and artifact versions append concurrently", async () => {
  const source = await seedUser(),
    destination = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-snapshot-"));
  const realSelect = db.select;
  const realBatch = client.batch;
  const originalSelect = realSelect.bind(db);
  const originalBatch = realBatch.bind(client);
  const artifact = await createArtifact(source, {
    title: "Snapshot artifact",
    content: "artifact version one",
  });
  const spec: RecipeSpec = {
    title: "Snapshot recipe",
    description: "",
    promptTemplate: "recipe version one",
    parameters: [],
    requirements: { skills: [], mcpServers: [], workspace: false, webSearch: false },
    outputFormat: "markdown",
  };
  const recipe = await createRecipe(source, spec);
  let release!: () => void;
  const changed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let injected = false,
    mutating = false,
    parentReads = 0;
  let mutation: Promise<void> | null = null;
  const inject = () =>
    (mutation ??= (async () => {
      injected = true;
      mutating = true;
      try {
        await updateRecipe(source, recipe.id, { ...spec, promptTemplate: "recipe version two" }, 1);
        await appendArtifactVersion(source, artifact.artifact.id, {
          expectedVersion: 1,
          content: "artifact version two",
        });
      } finally {
        mutating = false;
        release();
      }
    })());
  function wrap<T extends object>(target: T, table?: unknown): T {
    return new Proxy(target, {
      get(inner, property) {
        if (property === "then")
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            (async () => {
              if (!mutating && (table === taskRecipeVersions || table === savedArtifactVersions))
                await changed;
              const value = await Promise.resolve(inner);
              if (!mutating && (table === taskRecipes || table === savedArtifacts)) {
                parentReads++;
                if (parentReads === 2) await inject();
                else await changed;
              }
              return value;
            })().then(resolve, reject);
        const value = Reflect.get(inner, property, inner);
        if (typeof value !== "function") return value;
        // Batch prepares builders without individually executing their then().
        if (property === "_prepare") return value.bind(inner);
        return (...args: unknown[]) => {
          const result = value.apply(inner, args);
          return result && typeof result === "object"
            ? wrap(result, property === "from" ? args[0] : table)
            : result;
        };
      },
    });
  }
  try {
    db.select = ((...args: Parameters<typeof db.select>) =>
      wrap(originalSelect(...args))) as typeof db.select;
    client.batch = async (...args: Parameters<typeof client.batch>) => {
      const snapshot = await originalBatch(...args);
      await inject();
      return snapshot;
    };
    const exported = await exportBackup(source, path.join(dir, "first"));
    db.select = realSelect;
    client.batch = realBatch;
    expect(injected).toBe(true);
    expect((await getRecipe(source, recipe.id))?.recipe.version).toBe(2);
    expect((await getArtifactDetail(source, artifact.artifact.id)).artifact.currentVersion).toBe(2);
    expect(exported.manifest.contents.recipeVersions).toBe(1);
    expect(exported.manifest.contents.artifactVersions).toBe(1);
    const restored = await importOpenHornBackup(destination, exported.filePath);
    expect(restored.recipes).toEqual({ imported: 1, skipped: 0 });
    expect(restored.artifacts).toEqual({ imported: 1, skipped: 0 });
    const [copiedRecipe] = await listRecipes(destination);
    const [copiedArtifact] = await listArtifacts(destination);
    expect(copiedRecipe.version).toBe(1);
    expect((await getRecipe(destination, copiedRecipe.id))?.versions).toHaveLength(1);
    expect((await getArtifactDetail(destination, copiedArtifact.id)).version.content).toBe(
      "artifact version one",
    );
    const subsequent = await exportBackup(source, path.join(dir, "second"));
    expect(subsequent.manifest.contents.recipeVersions).toBe(2);
    expect(subsequent.manifest.contents.artifactVersions).toBe(2);
  } finally {
    db.select = realSelect;
    client.batch = realBatch;
    release();
    await mutation?.catch(() => {});
    await cleanupUser(source);
    await cleanupUser(destination);
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup refuses an oversized source before creating a ZIP", async () => {
  const { open, readdir } = await import("node:fs/promises");
  const { BACKUP_ARCHIVE_LIMITS } = await import("./backupArchiveBudget");
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-budget-test-"));
  try {
    const conversationId = await seedConversation(userId);
    const filePath = path.join(dir, "large.bin");
    const file = await open(filePath, "w");
    await file.truncate(BACKUP_ARCHIVE_LIMITS.entryBytes + 1);
    await file.close();
    await seedAttachment(conversationId, filePath, "large.bin");
    let code: unknown;
    try {
      await exportBackup(userId, path.join(dir, "output"));
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe("backup_size_limit");
    expect(await readdir(path.join(dir, "output"))).toEqual([]);
  } finally {
    await cleanupUser(userId);
    await rm(dir, { recursive: true, force: true });
  }
});

test("backup deletes incomplete output when a source grows after preflight", async () => {
  const { readdir } = await import("node:fs/promises");
  const { BACKUP_ARCHIVE_LIMITS } = await import("./backupArchiveBudget");
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-backup-growth-test-"));
  try {
    const conversationId = await seedConversation(userId);
    const filePath = path.join(dir, "growing.bin");
    await writeFile(filePath, "small at preflight");
    await seedAttachment(conversationId, filePath, "growing.bin");
    let mutated = false,
      code: unknown;
    try {
      await exportBackup(userId, path.join(dir, "output"), (progress) => {
        if (progress.phase !== "metadata" || mutated) return;
        mutated = true;
        // The synchronous callback simulates another writer extending the source after stat.
        const { truncateSync } = require("node:fs") as typeof import("node:fs");
        truncateSync(filePath, BACKUP_ARCHIVE_LIMITS.entryBytes + 1);
      });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(mutated).toBe(true);
    expect(code).toBe("backup_size_limit");
    expect(await readdir(path.join(dir, "output"))).toEqual([]);
  } finally {
    await cleanupUser(userId);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("backup retry restores a complete conversation after an interrupted message transaction", async () => {
  const source = await seedUser(),
    destination = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-restore-retry-test-"));
  const trigger = `reject_restore_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const conversationId = await seedConversation(source);
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId,
      role: "assistant",
      content: "INTERRUPT_THIS_RESTORE",
      createdAt: new Date(),
    });
    const backup = await exportBackup(source, dir);
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON messages WHEN NEW.content='INTERRUPT_THIS_RESTORE' BEGIN SELECT RAISE(ABORT,'Synthetic message failure'); END;`,
    );
    const first = await importOpenHornBackup(destination, backup.filePath);
    expect(first.backupFailure).toBe("interrupted");
    expect(first.conversations.imported).toBe(0);
    expect(first.messages.imported).toBe(0);
    expect(
      await db.select().from(conversations).where(eq(conversations.userId, destination)),
    ).toHaveLength(0);
    await client.execute(`DROP TRIGGER ${trigger}`);
    const retry = await importOpenHornBackup(destination, backup.filePath);
    expect(retry.backupFailure).toBe(undefined);
    expect(retry.conversations.imported).toBe(1);
    expect(retry.messages.imported).toBe(2);
    const repeated = await importOpenHornBackup(destination, backup.filePath);
    expect(repeated.conversations.skipped).toBe(1);
    expect(repeated.messages.imported).toBe(0);
    expect(repeated.errors).toEqual([]);
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await cleanupUser(source);
    await cleanupUser(destination);
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-archive retry completes missing attachments without resurrecting a deliberately deleted one", async () => {
  const source = await seedUser(),
    destination = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-restore-attachments-test-"));
  const trigger = `reject_attachment_${crypto.randomUUID().replaceAll("-", "")}`;
  const previousDataDir = process.env.OPENHORN_DATA_DIR;
  process.env.OPENHORN_DATA_DIR = path.join(dir, "restored");
  try {
    const conversationId = await seedConversation(source);
    const firstPath = path.join(dir, "first.txt"),
      secondPath = path.join(dir, "second.txt");
    await writeFile(firstPath, "first");
    await writeFile(secondPath, "second");
    await seedAttachment(conversationId, firstPath, "completed-first.txt");
    await seedAttachment(conversationId, secondPath, "retry-second.txt");
    const backup = await exportBackup(source, dir);
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON attachments WHEN NEW.file_name='retry-second.txt' BEGIN SELECT RAISE(ABORT,'Synthetic attachment failure'); END;`,
    );
    const first = await importOpenHornBackup(destination, backup.filePath);
    expect(first.backupFailure).toBe("interrupted");
    expect(first.attachments.imported).toBe(1);
    const [restored] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, destination));
    const [original] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.conversationId, restored.id));
    await db.delete(attachments).where(eq(attachments.id, original.id));
    await client.execute(`DROP TRIGGER ${trigger}`);
    const retried = await importOpenHornBackup(destination, backup.filePath);
    expect(retried.backupFailure).toBe(undefined);
    expect(retried.attachments.imported).toBe(1);
    const final = await db
      .select()
      .from(attachments)
      .where(eq(attachments.conversationId, restored.id));
    expect(final.map((row) => row.fileName)).toEqual(["retry-second.txt"]);
    expect((await importOpenHornBackup(destination, backup.filePath)).attachments.imported).toBe(0);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENHORN_DATA_DIR;
    else process.env.OPENHORN_DATA_DIR = previousDataDir;
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await cleanupUser(source);
    await cleanupUser(destination);
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy partial conversations without resume evidence report missing messages instead of a false success", async () => {
  const source = await seedUser(),
    destination = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-legacy-restore-test-"));
  try {
    const id = await seedConversation(source);
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: id,
      role: "assistant",
      content: "Legacy missing reply",
      createdAt: new Date(),
    });
    const backup = await exportBackup(source, dir);
    await importOpenHornBackup(destination, backup.filePath);
    const [restored] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, destination));
    const rows = await db.select().from(messages).where(eq(messages.conversationId, restored.id));
    await db
      .delete(backupRestoreConversations)
      .where(eq(backupRestoreConversations.userId, destination));
    await db
      .delete(messages)
      .where(eq(messages.id, rows.find((row) => row.role === "assistant")?.id as string));
    const retried = await importOpenHornBackup(destination, backup.filePath);
    expect(retried.conversations.skipped).toBe(1);
    expect(retried.messages.imported).toBe(0);
    expect(
      retried.errors.some((error) =>
        error.startsWith("Existing conversation has missing backup messages"),
      ),
    ).toBe(true);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, restored.id)),
    ).toHaveLength(1);
  } finally {
    await cleanupUser(source);
    await cleanupUser(destination);
    await rm(dir, { recursive: true, force: true });
  }
});
