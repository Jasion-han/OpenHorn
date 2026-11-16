import { expect, test } from "bun:test";
import { channels, settings, users } from "db";
import { and, eq } from "drizzle-orm";
import {
  LEGACY_TOOL_KEY,
  readToolRuntime,
  TOOL_CONNECTION_SETTING,
  TOOL_RUNTIME_SETTING,
} from "shared/tool-connection";
import { db } from "../db";
import { encrypt } from "../utils";
import { isSafeBackupSetting } from "./backupSanitizer";
import { deleteLibraryDocument, ocrLibraryDocument, uploadLibraryDocument } from "./libraryService";
import { deleteSettingValue, getSettingValues, setSettingValue } from "./settingsService";
import { toolConnectionFingerprint } from "./toolConnectionService";

test("tool connections save as one encrypted tuple, exclude backups and never fall back across targets", async () => {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "tools",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const connection = {
    source: "manual",
    kind: "deepseek",
    baseUrl: "https://relay.example.com/v1",
    apiKey: "relay-only",
  };
  try {
    await setSettingValue(id, LEGACY_TOOL_KEY, "old-official-only");
    await setSettingValue(id, TOOL_CONNECTION_SETTING, JSON.stringify(connection));
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, TOOL_CONNECTION_SETTING)));
    expect(row.value.startsWith("v2:")).toBe(true);
    expect(row.value.includes(connection.apiKey)).toBe(false);
    expect(
      isSafeBackupSetting({ key: TOOL_CONNECTION_SETTING, value: JSON.stringify(connection) }),
    ).toBe(false);
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))).toMatchObject(
      connection,
    );
    expect(
      readToolRuntime(await getSettingValues("another-user", [TOOL_RUNTIME_SETTING])),
    ).toBeUndefined();
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({ ...connection, apiKey: "" }),
    );
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))).toBeUndefined();
    await expect(setSettingValue(id, TOOL_RUNTIME_SETTING, "forged")).rejects.toThrow();
    await expect(deleteSettingValue(id, TOOL_RUNTIME_SETTING)).rejects.toThrow();
    await expect(
      setSettingValue(
        id,
        TOOL_CONNECTION_SETTING,
        JSON.stringify({ ...connection, baseUrl: "http://127.0.0.1" }),
      ),
    ).rejects.toThrow();
    const rows = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, id), eq(settings.key, TOOL_CONNECTION_SETTING)));
    expect(rows).toHaveLength(1);
  } finally {
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

test("channel references resolve only owned enabled OpenAI channels and track updated keys", async () => {
  const id = crypto.randomUUID(),
    channelId = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "tools",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    await db.insert(channels).values({
      id: channelId,
      userId: id,
      name: "Tool relay",
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://relay.example.com/v1",
      apiKey: encrypt("channel-only"),
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({ source: "channel", channelId, kind: "openrouter", model: "test/model" }),
    );
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))?.apiKey).toBe(
      "channel-only",
    );
    await db
      .update(channels)
      .set({ apiKey: encrypt("updated-channel-only") })
      .where(eq(channels.id, channelId));
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))?.apiKey).toBe(
      "updated-channel-only",
    );
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({ source: "channel", channelId: "foreign-id", kind: "deepseek" }),
    );
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))).toBeUndefined();
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({ source: "channel", channelId, kind: "deepseek" }),
    );
    await db.update(channels).set({ enabled: false }).where(eq(channels.id, channelId));
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))).toBeUndefined();
    await db.delete(channels).where(eq(channels.id, channelId));
    expect(readToolRuntime(await getSettingValues(id, [TOOL_RUNTIME_SETTING]))).toBeUndefined();
  } finally {
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(channels).where(eq(channels.id, channelId));
    await db.delete(users).where(eq(users.id, id));
  }
});

test("OCR consent is invalidated when the configured destination changes", async () => {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: "tools",
    email: `${id}@test.local`,
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let document: { id: string; revision: number } | undefined;
  try {
    document = (
      await uploadLibraryDocument(
        id,
        { kind: "personal" },
        "owned.txt",
        Buffer.from("owned source"),
      )
    ).document;
    const old = {
      kind: "deepseek" as const,
      baseUrl: "https://first.example.com/v1",
      apiKey: "first-only",
    };
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({ ...old, source: "manual" }),
    );
    const token = toolConnectionFingerprint(old);
    await setSettingValue(
      id,
      TOOL_CONNECTION_SETTING,
      JSON.stringify({
        ...old,
        source: "manual",
        baseUrl: "https://second.example.com/v1",
        apiKey: "second-only",
      }),
    );
    await expect(ocrLibraryDocument(id, document.id, token)).rejects.toMatchObject({
      code: "library_conflict",
    });
    await expect(ocrLibraryDocument(id, document.id)).rejects.toMatchObject({
      code: "library_conflict",
    });
  } finally {
    if (document) await deleteLibraryDocument(id, document.id, document.revision);
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});
