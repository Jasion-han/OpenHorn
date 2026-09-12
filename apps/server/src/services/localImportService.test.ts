import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { attachments, conversations, importRecords, messages, projects, settings, users } from "db";
import { asc, eq, sql } from "drizzle-orm";
import { GLOBAL_SYSTEM_PROMPT_SETTING_KEY, PROMPT_TEMPLATES_SETTING_KEY } from "shared/constants";
import type { PromptTemplate } from "shared/types";
import { db } from "../db";
import {
  listLocalConversations,
  mergeConsecutiveAssistant,
  mergeInstructions,
  parsePromptFile,
  runLocalImport,
  scanLocalSources,
  stripImagePlaceholders,
} from "./localImportService";
import { getSettingValues } from "./settingsService";

const FIXTURE_HOME = fileURLToPath(new URL("./__fixtures__/local-import/home", import.meta.url));
/** One Claude session + one Codex thread whose single reply is split across tool calls. */
const FIXTURE_HOME_MERGE = fileURLToPath(
  new URL("./__fixtures__/local-import/home-merge", import.meta.url),
);

const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";
const CLAUDE_SDK_SESSION = "22222222-2222-4222-8222-222222222222";
const CLAUDE_LEGACY_TASK_SESSION = "55555555-5555-4555-8555-555555555555";
const CLAUDE_MERGE_SESSION = "66666666-6666-4666-8666-666666666666";
const CODEX_THREAD = "01999999-0000-7000-8000-000000000001";
const CODEX_OPENHORN_THREAD = "01999999-0000-7000-8000-000000000002";
const CODEX_MERGE_THREAD = "01999999-0000-7000-8000-000000000004";
const CLAUDE_FILE = `.claude/projects/-Users-test-Project-alpha/${CLAUDE_SESSION}.jsonl`;
/** 1x1 transparent PNG — the payload of the image blocks in the fixtures. */
const PNG_1X1_BYTES = 70;

/**
 * The fixtures live under `dot-claude` / `dot-codex` / `dot-gemini` because the
 * repo .gitignore drops any `.claude/` or `.codex/` directory. Each test gets
 * its own copy laid out like a real $HOME (symlinks kept verbatim so
 * `.codex/prompts/pua.md -> ../pua/commands/pua.md` still resolves inside it).
 */
async function materializeHome(fixtureHome = FIXTURE_HOME): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openhorn-local-import-"));
  for (const [from, to] of [
    ["dot-claude", ".claude"],
    ["dot-codex", ".codex"],
    ["dot-gemini", ".gemini"],
  ] as const) {
    const source = path.join(fixtureHome, from);
    if (!existsSync(source)) continue;
    await cp(source, path.join(home, to), { recursive: true, verbatimSymlinks: true });
  }
  return home;
}

async function seedUser(): Promise<string> {
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function cleanupUser(userId: string) {
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  for (const c of convs) {
    await db.delete(attachments).where(eq(attachments.conversationId, c.id));
    await db.delete(messages).where(eq(messages.conversationId, c.id));
  }
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(projects).where(eq(projects.userId, userId));
  await db.delete(settings).where(eq(settings.userId, userId));
  await db.delete(importRecords).where(eq(importRecords.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function loadMessages(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function loadAttachments(conversationId: string) {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.conversationId, conversationId))
    .orderBy(asc(attachments.createdAt));
}

const homes: string[] = [];
let sharedHome = "";
/** Attachment blobs go under `$OPENHORN_DATA_DIR/attachments`; keep them out of the real data dir. */
let dataDir = "";
const previousDataDir = process.env.OPENHORN_DATA_DIR;

beforeAll(async () => {
  sharedHome = await materializeHome();
  homes.push(sharedHome);
  dataDir = await mkdtemp(path.join(tmpdir(), "openhorn-local-import-data-"));
  process.env.OPENHORN_DATA_DIR = dataDir;
});

afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.OPENHORN_DATA_DIR;
  else process.env.OPENHORN_DATA_DIR = previousDataDir;
});

// ---------------------------------------------------------------------------
// scan / list
// ---------------------------------------------------------------------------

test("scan: counts importable sessions per source and skips SDK / OpenHorn / subagent / empty files", async () => {
  const userId = await seedUser();
  try {
    const result = await scanLocalSources(userId, { homeDir: sharedHome });
    const bySource = new Map(result.sources.map((s) => [s.source, s]));

    const claude = bySource.get("claude-code");
    expect(claude?.available).toBe(true);
    // 5 files: 1 real, 1 sdk-cli (OpenHorn-produced), 1 legacy scheduled-task prompt
    // (OpenHorn-produced, no entrypoint field), 1 meta-only, 1 empty; subagents dir ignored.
    expect(claude?.parts.conversations).toEqual({ count: 1, handledBy: "server" });
    expect(claude?.parts.instructions?.count).toBe(1);
    // review.md + frontend/lint.md + empty.md (counted at scan time; body check happens on import)
    expect(claude?.parts.prompts?.count).toBe(3);
    expect(claude?.parts.mcp).toEqual({ handledBy: "desktop" });

    const codex = bySource.get("codex");
    expect(codex?.parts.conversations).toEqual({ count: 1, handledBy: "server" });
    // AGENTS.md is present but empty → nothing to import
    expect(codex?.parts.instructions?.count).toBe(0);
    // prompts/pua.md is a symlink and must be followed
    expect(codex?.parts.prompts?.count).toBe(1);

    const gemini = bySource.get("gemini");
    expect(gemini?.available).toBe(true);
    expect(gemini?.parts.conversations).toBeUndefined();
    expect(gemini?.parts.instructions?.count).toBe(0);

    expect(bySource.get("cursor")?.available).toBe(false);
  } finally {
    await cleanupUser(userId);
  }
});

test("list: claude titles come from ai-title, codex from first user prompt; alreadyImported flips after run", async () => {
  const userId = await seedUser();
  try {
    const claude = await listLocalConversations(userId, "claude-code", { homeDir: sharedHome });
    expect(claude.conversations.map((c) => c.id)).toEqual([CLAUDE_SESSION]);
    expect(claude.conversations[0].title).toBe("Login bug fix");
    expect(claude.conversations[0].cwd).toBe("/Users/test/Project/alpha");
    expect(claude.conversations[0].alreadyImported).toBe(false);

    const codex = await listLocalConversations(userId, "codex", { homeDir: sharedHome });
    expect(codex.conversations.map((c) => c.id)).toEqual([CODEX_THREAD]);
    expect(codex.conversations[0].title).toBe("Add a health endpoint");

    await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: sharedHome },
    );
    const again = await listLocalConversations(userId, "claude-code", { homeDir: sharedHome });
    expect(again.conversations[0].alreadyImported).toBe(true);
  } finally {
    await cleanupUser(userId);
  }
});

// ---------------------------------------------------------------------------
// Claude Code conversations
// ---------------------------------------------------------------------------

test("claude: linearizes user/assistant text, folds one reply's message.ids into one row, drops meta/tool/compact/error lines", async () => {
  const userId = await seedUser();
  try {
    const project = {
      id: crypto.randomUUID(),
      userId,
      name: "alpha",
      rootPath: "/Users/test/Project/alpha",
      isStarred: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(projects).values(project);

    const result = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: sharedHome },
    );
    expect(result.errors).toEqual([]);
    // Messages are never their own part: they ride on the conversations part.
    expect(result.parts).toHaveLength(1);
    const convPart = result.parts.find((p) => p.type === "conversations");
    expect(convPart?.imported).toBe(1);
    // sdk-cli + legacy scheduled-task + meta-only sessions are reported as skipped
    expect(convPart?.skipped).toBe(3);
    expect(convPart?.note).toBe("共 4 条消息");
    const importedItem = convPart?.items.find((i) => i.status === "imported");
    expect(importedItem?.link).toEqual({ kind: "conversation", id: CLAUDE_SESSION });
    // png stored; gif is not an allowed attachment type; url-sourced image is not inline data.
    expect(importedItem?.detail).toBe(
      "4 条消息 · 含 1 张图片 · 1 张图片未导入（类型不支持或过大） · /Users/test/Project/alpha",
    );

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CLAUDE_SESSION));
    expect(conv.title).toBe("Login bug fix");
    expect(conv.modelId).toBe("claude-sonnet-4-6");
    expect(conv.defaultMode).toBe("agent");
    expect(conv.projectId).toBe(project.id);
    expect(conv.importedFrom).toBe("claude-code");
    expect(conv.importedAt).not.toBeNull();
    expect(conv.createdAt.getTime()).toBe(Date.parse("2026-09-01T10:00:01.000Z"));
    expect(conv.updatedAt.getTime()).toBe(Date.parse("2026-09-01T10:00:11.000Z"));

    const rows = await loadMessages(CLAUDE_SESSION);
    // msg_1 ("Let me look.") and msg_2 ("I found it…" + "Fixed.") are one reply
    // split by a tool call: text blocks of one message.id join with "\n", the
    // message.ids of one turn join with a blank line.
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Fix the login bug"],
      ["assistant", "Let me look.\n\nI found it in auth.ts\nFixed."],
      // gif skipped → the `[Image #1]` marker stays, the text is untouched
      ["user", "[Image #1] Thanks, also check signup"],
      ["assistant", "Signup looks fine."],
    ]);
    expect(rows.every((m) => m.mode === "agent")).toBe(true);
    expect(rows[1].model).toBe("claude-sonnet-4-6");
    // msg_1 (160 + 20) + msg_2 (200 + 30)
    expect(JSON.parse(rows[1].usage ?? "null")).toEqual({
      promptTokens: 360,
      completionTokens: 50,
      totalTokens: 410,
    });
    expect(rows[0].usage).toBeNull();
    // strictly increasing createdAt so ORDER BY created_at is deterministic
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].createdAt.getTime() > rows[i - 1].createdAt.getTime()).toBe(true);
    }

    // OpenHorn-produced sessions (sdk-cli entrypoint / legacy task prompt) never land in the DB.
    for (const id of [CLAUDE_SDK_SESSION, CLAUDE_LEGACY_TASK_SESSION]) {
      expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
    }

    // A record was written for the run.
    const records = await db.select().from(importRecords).where(eq(importRecords.userId, userId));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(result.recordId);
    expect(records[0].source).toBe("claude-code");
    expect(records[0].kind).toBe("local");
    expect(records[0].totalImported).toBe(1); // conversations only, not their messages
  } finally {
    await cleanupUser(userId);
  }
});

test("claude: explicit sessionIds restricts the run; unknown ids are ignored", async () => {
  const userId = await seedUser();
  try {
    const result = await runLocalImport(
      userId,
      {
        source: "claude-code",
        parts: { conversations: { sessionIds: [CLAUDE_SDK_SESSION, "not-a-session"] } },
      },
      { homeDir: sharedHome },
    );
    const convPart = result.parts.find((p) => p.type === "conversations");
    expect(convPart?.imported).toBe(0);
    expect(convPart?.skipped).toBe(1);
    const rows = await db.select().from(conversations).where(eq(conversations.userId, userId));
    expect(rows).toHaveLength(0);
  } finally {
    await cleanupUser(userId);
  }
});

test("claude: re-run skips unchanged for all, rewrites explicitly picked sessions, re-imports when the source grew", async () => {
  const userId = await seedUser();
  const home = await materializeHome();
  homes.push(home);
  try {
    const first = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: [CLAUDE_SESSION] } } },
      { homeDir: home },
    );
    expect(first.parts.find((p) => p.type === "conversations")?.imported).toBe(1);

    const firstRows = await loadMessages(CLAUDE_SESSION);
    expect(firstRows).toHaveLength(4);

    // "all" with an unchanged source file: nothing is touched.
    const second = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: home },
    );
    const secondPart = second.parts.find((p) => p.type === "conversations");
    expect(secondPart?.imported).toBe(0);
    const unchangedItem = secondPart?.items.find((i) => i.link?.id === CLAUDE_SESSION);
    expect(unchangedItem?.status).toBe("skipped");
    expect(unchangedItem?.detail).toBe("已导入且无变化");
    expect((await loadMessages(CLAUDE_SESSION)).map((m) => m.id)).toEqual(
      firstRows.map((m) => m.id),
    );
    expect(
      await db.select().from(conversations).where(eq(conversations.userId, userId)),
    ).toHaveLength(1);

    // Explicitly picked, same unchanged source file: forced rewrite so a parser
    // fix can reach an already-imported conversation. Rows are replaced, not
    // duplicated, and the conversation is not re-created.
    const forced = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: [CLAUDE_SESSION] } } },
      { homeDir: home },
    );
    const forcedPart = forced.parts.find((p) => p.type === "conversations");
    expect(forcedPart?.imported).toBe(1);
    expect(forcedPart?.skipped).toBe(0);
    expect(forcedPart?.items[0].link).toEqual({ kind: "conversation", id: CLAUDE_SESSION });
    expect(forcedPart?.items[0].detail?.startsWith("已更新 · 4 条消息")).toBe(true);
    const forcedRows = await loadMessages(CLAUDE_SESSION);
    expect(forcedRows.map((m) => [m.role, m.content])).toEqual(
      firstRows.map((m) => [m.role, m.content]),
    );
    expect(forcedRows.some((m) => firstRows.some((f) => f.id === m.id))).toBe(false);
    expect(
      await db.select().from(conversations).where(eq(conversations.userId, userId)),
    ).toHaveLength(1);

    // A turn the user added inside OpenHorn after importing (createdAt > importedAt)
    // must survive the re-import below; only previously imported rows are replaced.
    await db.insert(messages).values({
      id: "openhorn-authored",
      conversationId: CLAUDE_SESSION,
      role: "user",
      content: "typed in OpenHorn",
      mode: "agent",
      createdAt: new Date(Date.now() + 60_000),
    });

    // Source grows: a new user turn + answer after the previous last line.
    const cwd = "/Users/test/Project/alpha";
    const extra = [
      {
        type: "user",
        uuid: "u9",
        parentUuid: "s6",
        sessionId: CLAUDE_SESSION,
        cwd,
        entrypoint: "cli",
        isSidechain: false,
        timestamp: "2026-09-01T10:05:00.000Z",
        message: { role: "user", content: "One more thing" },
      },
      {
        type: "assistant",
        uuid: "s9",
        parentUuid: "u9",
        sessionId: CLAUDE_SESSION,
        cwd,
        entrypoint: "cli",
        isSidechain: false,
        timestamp: "2026-09-01T10:05:01.000Z",
        message: {
          id: "msg_9",
          model: "claude-opus-4-1",
          role: "assistant",
          type: "message",
          content: [{ type: "text", text: "Sure." }],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ];
    await appendFile(
      path.join(home, CLAUDE_FILE),
      `${extra.map((o) => JSON.stringify(o)).join("\n")}\n`,
    );

    const third = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: [CLAUDE_SESSION] } } },
      { homeDir: home },
    );
    const thirdPart = third.parts.find((p) => p.type === "conversations");
    expect(thirdPart?.imported).toBe(1);
    expect(thirdPart?.items[0].detail?.startsWith("已更新 · 6 条消息")).toBe(true);
    expect(thirdPart?.note).toBe("共 6 条消息");
    const rows = await loadMessages(CLAUDE_SESSION);
    expect(rows).toHaveLength(7);
    expect(rows[5].content).toBe("Sure.");
    expect(rows[6].id).toBe("openhorn-authored");
    // Previously imported rows were replaced, not duplicated.
    expect(rows.filter((row) => row.content === rows[0].content)).toHaveLength(1);
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CLAUDE_SESSION));
    expect(conv.modelId).toBe("claude-opus-4-1");
    expect(conv.updatedAt.getTime()).toBe(Date.parse("2026-09-01T10:05:01.000Z"));
  } finally {
    await cleanupUser(userId);
  }
});

test("claude: prompt images become attachments linked to the user message; re-import replaces rows and files", async () => {
  const userId = await seedUser();
  const home = await materializeHome();
  homes.push(home);
  try {
    await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: [CLAUDE_SESSION] } } },
      { homeDir: home },
    );
    const rows = await loadMessages(CLAUDE_SESSION);
    const imageUser = rows.find((m) => m.content === "[Image #1] Thanks, also check signup");
    expect(imageUser).toBeDefined();

    const first = await loadAttachments(CLAUDE_SESSION);
    expect(first).toHaveLength(1);
    expect(first[0].messageId).toBe(imageUser?.id);
    expect(first[0].fileName).toBe("image-1.png");
    expect(first[0].fileType).toBe("image/png");
    expect(first[0].fileSize).toBe(PNG_1X1_BYTES);
    // Same directory layout as chat uploads, under the test data dir.
    expect(path.dirname(first[0].filePath)).toBe(path.join(dataDir, "attachments", CLAUDE_SESSION));
    expect((await stat(first[0].filePath)).size).toBe(PNG_1X1_BYTES);

    // Source grows → re-import replaces the previously imported rows: the old
    // attachment row and its blob must go with them (no FK cascade to rely on).
    await appendFile(
      path.join(home, CLAUDE_FILE),
      `${JSON.stringify({
        type: "user",
        uuid: "u9",
        parentUuid: "s6",
        sessionId: CLAUDE_SESSION,
        cwd: "/Users/test/Project/alpha",
        entrypoint: "cli",
        isSidechain: false,
        timestamp: "2026-09-01T10:05:00.000Z",
        message: { role: "user", content: "One more thing" },
      })}\n`,
    );
    await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: [CLAUDE_SESSION] } } },
      { homeDir: home },
    );
    const second = await loadAttachments(CLAUDE_SESSION);
    expect(second).toHaveLength(1);
    expect(second[0].id === first[0].id).toBe(false);
    expect(existsSync(first[0].filePath)).toBe(false);
    expect(existsSync(second[0].filePath)).toBe(true);
    const again = await loadMessages(CLAUDE_SESSION);
    expect(second[0].messageId).toBe(
      again.find((m) => m.content === "[Image #1] Thanks, also check signup")?.id,
    );
  } finally {
    await cleanupUser(userId);
  }
});

test("stripImagePlaceholders: removes markers, collapses spaces, drops marker-only lines, leaves other text alone", () => {
  expect(stripImagePlaceholders("no markers  here ")).toBe("no markers  here ");
  expect(stripImagePlaceholders("[Image #1] fix it")).toBe("fix it");
  expect(stripImagePlaceholders("fix [Image #12]  this  [Image #3] now")).toBe("fix this now");
  expect(stripImagePlaceholders("[Image #1]\n[Image #2]\nlook  at  these\n  [Image #3]  ")).toBe(
    "look  at  these",
  );
  expect(stripImagePlaceholders("[Image #1]")).toBe("");
  expect(stripImagePlaceholders("[Image #x] kept")).toBe("[Image #x] kept");
});

test("mergeConsecutiveAssistant: folds assistant runs, sums usage, keeps first createdAt and last model", () => {
  const merged = mergeConsecutiveAssistant([
    { role: "user", content: "q", model: null, usage: null, createdAt: 1 },
    { role: "assistant", content: " a \n", model: "m1", usage: null, createdAt: 2 },
    { role: "assistant", content: "   ", model: null, usage: null, createdAt: 3 },
    {
      role: "assistant",
      content: "b",
      model: "m2",
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      createdAt: 4,
    },
    {
      role: "assistant",
      content: "c",
      model: null,
      usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
      createdAt: 5,
    },
    { role: "user", content: "q2", model: null, usage: null, createdAt: 6 },
    { role: "assistant", content: "d", model: null, usage: null, createdAt: 7 },
  ]);
  expect(merged).toEqual([
    { role: "user", content: "q", model: null, usage: null, createdAt: 1 },
    {
      role: "assistant",
      content: "a\n\nb\n\nc",
      model: "m2",
      usage: { promptTokens: 30, completionTokens: 3, totalTokens: 33 },
      createdAt: 2,
    },
    { role: "user", content: "q2", model: null, usage: null, createdAt: 6 },
    { role: "assistant", content: "d", model: null, usage: null, createdAt: 7 },
  ]);
});

test("claude: one reply spread over 3 message.ids with tool calls in between imports as 1 user + 1 assistant", async () => {
  const userId = await seedUser();
  const home = await materializeHome(FIXTURE_HOME_MERGE);
  homes.push(home);
  try {
    const result = await runLocalImport(
      userId,
      { source: "claude-code", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: home },
    );
    expect(result.errors).toEqual([]);
    const convPart = result.parts.find((p) => p.type === "conversations");
    expect(convPart?.note).toBe("共 2 条消息");
    expect(convPart?.items.find((i) => i.status === "imported")?.detail).toBe(
      "2 条消息 · 含 2 张图片 · /Users/test/Project/merge",
    );
    const rows = await loadMessages(CLAUDE_MERGE_SESSION);
    // Both pngs stored → the `[Image #N]` markers are gone: the marker-only
    // first line is dropped, the inline one leaves a single space.
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Remove the arrow from the icon"],
      ["assistant", "Looking at the icon.\n\nFound it in Icon.tsx.\n\nRemoved the arrow."],
    ]);
    const stored = await loadAttachments(CLAUDE_MERGE_SESSION);
    expect(stored).toHaveLength(2);
    expect(stored.map((a) => a.messageId)).toEqual([rows[0].id, rows[0].id]);
    expect(stored.map((a) => a.fileName)).toEqual(["image-1.png", "image-2.png"]);
    // Search sees the cleaned text, not the original with markers.
    const fts = await db.all<{ content: string }>(
      sql`SELECT content FROM messages_fts WHERE message_id = ${rows[0].id}`,
    );
    expect(fts.map((r) => r.content)).toEqual(["Remove the arrow from the icon"]);
    expect(JSON.parse(rows[1].usage ?? "null")).toEqual({
      promptTokens: 60,
      completionTokens: 6,
      totalTokens: 66,
    });
    expect(rows[1].createdAt.getTime()).toBe(Date.parse("2026-09-02T09:00:01.000Z"));
  } finally {
    await cleanupUser(userId);
  }
});

// ---------------------------------------------------------------------------
// Codex conversations
// ---------------------------------------------------------------------------

test("codex: drops developer/injected/commentary, keeps final answers with model + usage, skips openhorn-originated threads", async () => {
  const userId = await seedUser();
  try {
    const result = await runLocalImport(
      userId,
      { source: "codex", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: sharedHome },
    );
    expect(result.errors).toEqual([]);
    const convPart = result.parts.find((p) => p.type === "conversations");
    expect(convPart?.imported).toBe(1);
    expect(convPart?.skipped).toBe(1); // originator: openhorn

    const rows = await loadMessages(CODEX_THREAD);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Add a health endpoint"],
      ["assistant", "Added GET /health."],
      // the only inline image is stored (the remote url is not an image to
      // import at all), so the `[Image #1]` marker is dropped
      ["user", "make it return json"],
      ["assistant", 'Done, returns {"ok":true}.'],
    ]);
    expect(rows[1].model).toBe("gpt-5-codex");
    expect(JSON.parse(rows[1].usage ?? "null")).toEqual({
      promptTokens: 500,
      completionTokens: 40,
      totalTokens: 540,
    });
    expect(rows[3].usage).toBeNull();

    // The `input_image` data URL on the second prompt becomes an attachment; the
    // remote-url one is dropped.
    const stored = await loadAttachments(CODEX_THREAD);
    expect(stored).toHaveLength(1);
    expect(stored[0].messageId).toBe(rows[2].id);
    expect(stored[0].fileType).toBe("image/png");
    expect(stored[0].fileSize).toBe(PNG_1X1_BYTES);
    expect(convPart?.items.find((i) => i.status === "imported")?.detail).toBe(
      "4 条消息 · 含 1 张图片 · /Users/test/Project/alpha",
    );

    const [conv] = await db.select().from(conversations).where(eq(conversations.id, CODEX_THREAD));
    expect(conv.title).toBe("Add a health endpoint");
    expect(conv.modelId).toBe("gpt-5-codex");
    expect(conv.importedFrom).toBe("codex");
    expect(conv.createdAt.getTime()).toBe(Date.parse("2026-09-01T11:00:00.000Z"));
    expect(conv.updatedAt.getTime()).toBe(Date.parse("2026-09-01T11:00:12.000Z"));

    const skipped = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, CODEX_OPENHORN_THREAD));
    expect(skipped).toHaveLength(0);
  } finally {
    await cleanupUser(userId);
  }
});

test("codex: one reply spread over 3 assistant messages with a tool call in between imports as 1 user + 1 assistant", async () => {
  const userId = await seedUser();
  const home = await materializeHome(FIXTURE_HOME_MERGE);
  homes.push(home);
  try {
    const result = await runLocalImport(
      userId,
      { source: "codex", parts: { conversations: { sessionIds: "all" } } },
      { homeDir: home },
    );
    expect(result.errors).toEqual([]);
    expect(result.parts.find((p) => p.type === "conversations")?.note).toBe("共 2 条消息");
    const rows = await loadMessages(CODEX_MERGE_THREAD);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "Add tests for the router"],
      ["assistant", "Writing tests.\n\nTests pass.\n\nDone."],
    ]);
    expect(rows[1].model).toBe("gpt-5-codex");
    expect(JSON.parse(rows[1].usage ?? "null")).toEqual({
      promptTokens: 300,
      completionTokens: 30,
      totalTokens: 330,
    });
    expect(rows[1].createdAt.getTime()).toBe(Date.parse("2026-09-02T09:00:03.000Z"));
  } finally {
    await cleanupUser(userId);
  }
});

test("codex: newest state_<n>.sqlite threads index supplies the title; a broken index falls back to jsonl", async () => {
  const userId = await seedUser();
  const home = await materializeHome();
  homes.push(home);
  try {
    const mkThreads = async (file: string) => {
      const c = createClient({ url: `file:${file}` });
      await c.execute(
        `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', cwd TEXT, created_at INTEGER, updated_at INTEGER)`,
      );
      return c;
    };
    // Older version: would give the wrong title if the newest file were not picked.
    const old = await mkThreads(path.join(home, ".codex", "state_3.sqlite"));
    await old.execute({
      sql: `INSERT INTO threads (id, rollout_path, name, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [CODEX_THREAD, "x", null, "OLD TITLE", "/Users/test/Project/alpha", 1, 2],
    });
    old.close();
    const newest = await mkThreads(path.join(home, ".codex", "state_12.sqlite"));
    await newest.execute({
      sql: `INSERT INTO threads (id, rollout_path, name, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        CODEX_THREAD,
        "x",
        "Health endpoint work",
        "auto title",
        "/Users/test/Project/alpha",
        1,
        2,
      ],
    });
    newest.close();

    const listed = await listLocalConversations(userId, "codex", { homeDir: home });
    expect(listed.conversations[0].title).toBe("Health endpoint work");

    const result = await runLocalImport(
      userId,
      { source: "codex", parts: { conversations: { sessionIds: [CODEX_THREAD] } } },
      { homeDir: home },
    );
    expect(result.parts.find((p) => p.type === "conversations")?.imported).toBe(1);
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, CODEX_THREAD));
    expect(conv.title).toBe("Health endpoint work");

    // Corrupt newest index → ignore it, jsonl still wins.
    await writeFile(path.join(home, ".codex", "state_13.sqlite"), "not a database");
    const fallback = await listLocalConversations(userId, "codex", { homeDir: home });
    expect(fallback.conversations[0].title).toBe("Add a health endpoint");
  } finally {
    await cleanupUser(userId);
  }
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test("mergeInstructions: appends with a marker, then replaces the marked segment in place", () => {
  const marker = "<!-- imported: claude-code CLAUDE.md -->";
  const first = mergeInstructions("Be concise.", marker, "Rule A\nRule B");
  expect(first.replaced).toBe(false);
  expect(first.value).toBe(`Be concise.\n\n${marker}\nRule A\nRule B`);

  const other = "<!-- imported: codex AGENTS.md -->";
  const withOther = `${first.value}\n\n${other}\nCodex rule`;
  const second = mergeInstructions(withOther, marker, "Rule A v2");
  expect(second.replaced).toBe(true);
  expect(second.value).toBe(`Be concise.\n\n${marker}\nRule A v2\n\n${other}\nCodex rule`);

  const empty = mergeInstructions(undefined, marker, "  Only  ");
  expect(empty.value).toBe(`${marker}\nOnly`);
});

test("instructions: CLAUDE.md is appended to chat.systemPrompt once; empty AGENTS.md is skipped", async () => {
  const userId = await seedUser();
  try {
    await db.insert(settings).values({
      id: crypto.randomUUID(),
      userId,
      key: GLOBAL_SYSTEM_PROMPT_SETTING_KEY,
      value: "Existing prompt.",
      updatedAt: new Date(),
    });

    const first = await runLocalImport(
      userId,
      { source: "claude-code", parts: { instructions: true } },
      { homeDir: sharedHome },
    );
    const part = first.parts.find((p) => p.type === "instructions");
    expect(part?.imported).toBe(1);
    expect(part?.items[0].link).toEqual({ kind: "settings-tab", id: "general" });

    const marker = "<!-- imported: claude-code CLAUDE.md -->";
    let value = (await getSettingValues(userId, [GLOBAL_SYSTEM_PROMPT_SETTING_KEY]))[
      GLOBAL_SYSTEM_PROMPT_SETTING_KEY
    ];
    expect(value.startsWith("Existing prompt.\n\n")).toBe(true);
    expect(value.split(marker)).toHaveLength(2);
    expect(value.includes("2. Never auto-commit.")).toBe(true);

    await runLocalImport(
      userId,
      { source: "claude-code", parts: { instructions: true } },
      { homeDir: sharedHome },
    );
    value = (await getSettingValues(userId, [GLOBAL_SYSTEM_PROMPT_SETTING_KEY]))[
      GLOBAL_SYSTEM_PROMPT_SETTING_KEY
    ];
    expect(value.split(marker)).toHaveLength(2);
    expect(value.split("2. Never auto-commit.")).toHaveLength(2);

    const codex = await runLocalImport(
      userId,
      { source: "codex", parts: { instructions: true } },
      { homeDir: sharedHome },
    );
    const codexPart = codex.parts.find((p) => p.type === "instructions");
    expect(codexPart?.imported).toBe(0);
    expect(codexPart?.skipped).toBe(1);
    expect(codexPart?.items[0].detail).toBe("文件为空");
  } finally {
    await cleanupUser(userId);
  }
});

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

test("parsePromptFile: frontmatter description / argument-hint + body; no frontmatter → whole file is body", () => {
  expect(
    parsePromptFile(
      '---\ndescription: "Do X"\nargument-hint: [scope]\nmodel: opus\n---\nBody $ARGUMENTS\n',
    ),
  ).toEqual({
    description: "Do X",
    argumentHint: "[scope]",
    body: "Body $ARGUMENTS",
  });
  expect(parsePromptFile("Just text\n")).toEqual({ body: "Just text" });
  expect(parsePromptFile("---\ndescription: unterminated\nBody")).toEqual({
    body: "---\ndescription: unterminated\nBody",
  });
});

test("prompts: claude commands (namespaced) and codex prompts (symlinked) land in prompts.templates, deduped by source+name", async () => {
  const userId = await seedUser();
  try {
    const claude = await runLocalImport(
      userId,
      { source: "claude-code", parts: { prompts: true } },
      { homeDir: sharedHome },
    );
    const claudePart = claude.parts.find((p) => p.type === "prompts");
    expect(claudePart?.imported).toBe(2);
    expect(claudePart?.skipped).toBe(1); // empty.md has no body

    const codex = await runLocalImport(
      userId,
      { source: "codex", parts: { prompts: true } },
      { homeDir: sharedHome },
    );
    expect(codex.parts.find((p) => p.type === "prompts")?.imported).toBe(1);

    const raw = (await getSettingValues(userId, [PROMPT_TEMPLATES_SETTING_KEY]))[
      PROMPT_TEMPLATES_SETTING_KEY
    ];
    const templates = JSON.parse(raw) as PromptTemplate[];
    expect(templates).toHaveLength(3);
    const review = templates.find((t) => t.name === "review");
    expect(review?.source).toBe("claude-code");
    expect(review?.namespace).toBeUndefined();
    expect(review?.description).toBe("Review the current diff");
    expect(review?.argumentHint).toBe("[scope]");
    expect(review?.body).toBe("Review $ARGUMENTS for correctness and style.");
    const lint = templates.find((t) => t.name === "lint");
    expect(lint?.namespace).toBe("frontend");
    const pua = templates.find((t) => t.name === "pua");
    expect(pua?.source).toBe("codex");
    expect(pua?.description).toBe("Push harder");
    expect(pua?.argumentHint).toBe("<task>");
    const ids = templates.map((t) => t.id);
    expect(claudePart?.items.find((i) => i.label === "review")?.link).toEqual({
      kind: "prompt",
      id: review?.id,
    });

    // Re-import: same count, ids preserved, entries updated in place.
    await runLocalImport(
      userId,
      { source: "claude-code", parts: { prompts: true } },
      { homeDir: sharedHome },
    );
    const again = JSON.parse(
      (await getSettingValues(userId, [PROMPT_TEMPLATES_SETTING_KEY]))[
        PROMPT_TEMPLATES_SETTING_KEY
      ],
    ) as PromptTemplate[];
    expect(again).toHaveLength(3);
    expect(again.map((t) => t.id).sort()).toEqual(ids.sort());
  } finally {
    await cleanupUser(userId);
  }
});

test("prompts: a symlink escaping $HOME is refused", async () => {
  const userId = await seedUser();
  const home = await materializeHome();
  homes.push(home);
  const outside = await mkdtemp(path.join(tmpdir(), "openhorn-outside-"));
  try {
    await writeFile(path.join(outside, "secret.md"), "top secret");
    await mkdir(path.join(home, ".codex", "prompts"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(outside, "secret.md"), path.join(home, ".codex", "prompts", "leak.md"));

    const scan = await scanLocalSources(userId, { homeDir: home });
    expect(scan.sources.find((s) => s.source === "codex")?.parts.prompts?.count).toBe(1);

    const result = await runLocalImport(
      userId,
      { source: "codex", parts: { prompts: true } },
      { homeDir: home },
    );
    const part = result.parts.find((p) => p.type === "prompts");
    expect(part?.items.map((i) => i.label)).toEqual(["pua"]);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await cleanupUser(userId);
  }
});
