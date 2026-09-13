import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { conversations, importRecords, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { importChatGPT, importClaude } from "./importService";

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
  for (const c of convs) await db.delete(messages).where(eq(messages.conversationId, c.id));
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(importRecords).where(eq(importRecords.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function loadRows(userId: string) {
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt));
}

function chatGPTNode(
  id: string,
  parent: string | null,
  child: string | null,
  message: Record<string, unknown>,
) {
  return { id, parent, children: child ? [child] : [], message: { id, ...message } };
}

test("chatgpt import: thoughts, tool calls, tool outputs and interim text are steps; final text is the body", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-import-steps-"));
  try {
    const file = path.join(dir, "conversations.json");
    const t = 1_700_000_000;
    await writeFile(
      file,
      JSON.stringify([
        {
          title: "Weather thread",
          create_time: t,
          update_time: t + 100,
          current_node: "n8",
          mapping: {
            root: chatGPTNode("root", null, "n1", {
              author: { role: "system" },
              content: { content_type: "text", parts: [""] },
              create_time: t,
            }),
            n1: chatGPTNode("n1", "root", "n2", {
              author: { role: "user" },
              content: { content_type: "text", parts: ["weather in Paris and plot 2+2"] },
              create_time: t + 1,
            }),
            n2: chatGPTNode("n2", "n1", "n3", {
              author: { role: "assistant" },
              content: {
                content_type: "thoughts",
                thoughts: [{ summary: "Planning", content: "Search then compute." }],
              },
              metadata: { model_slug: "o3" },
              create_time: t + 2,
            }),
            n3: chatGPTNode("n3", "n2", "n4", {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ['search("Paris weather")'] },
              recipient: "browser",
              metadata: { model_slug: "o3" },
              create_time: t + 3,
            }),
            n4: chatGPTNode("n4", "n3", "n5", {
              author: { role: "tool", name: "browser" },
              content: {
                content_type: "tether_browsing_display",
                result: "Paris: 18°C, cloudy",
                summary: "1 result",
              },
              create_time: t + 4,
            }),
            n5: chatGPTNode("n5", "n4", "n6", {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Got the weather, now the math."] },
              recipient: "all",
              metadata: { model_slug: "o3" },
              create_time: t + 5,
            }),
            n6: chatGPTNode("n6", "n5", "n7", {
              author: { role: "assistant" },
              content: { content_type: "code", language: "python", text: "print(2+2)" },
              recipient: "python",
              metadata: { model_slug: "o3" },
              create_time: t + 6,
            }),
            n7: chatGPTNode("n7", "n6", "n8", {
              author: { role: "tool", name: "python" },
              content: { content_type: "execution_output", text: "4\n" },
              create_time: t + 7,
            }),
            n8: chatGPTNode("n8", "n7", null, {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Paris is 18°C and 2+2 is 4."] },
              recipient: "all",
              metadata: { model_slug: "o3" },
              create_time: t + 8,
            }),
          },
        },
      ]),
    );

    const result = await importChatGPT(userId, file);
    expect(result.errors).toEqual([]);
    expect(result.messages.imported).toBe(2);
    const rows = await loadRows(userId);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "weather in Paris and plot 2+2"],
      ["assistant", "Paris is 18°C and 2+2 is 4."],
    ]);
    expect(rows[0].mode).toBe("chat");
    expect(rows[0].agentRun).toBeNull();
    expect(rows[1].mode).toBe("agent");
    expect(rows[1].model).toBe("o3");
    expect(rows[1].createdAt.getTime()).toBe((t + 2) * 1000);
    expect(JSON.parse(rows[1].agentRun ?? "null")).toEqual({
      status: "completed",
      summary: "Agent 已调用 2 个工具",
      toolCount: 2,
      steps: [
        { type: "thinking", content: "**Planning**\n\nSearch then compute." },
        {
          type: "tool_start",
          toolName: "browser",
          toolInput: { query: 'search("Paris weather")' },
        },
        { type: "tool_result", content: "1 result\n\nParis: 18°C, cloudy", toolName: "browser" },
        { type: "reasoning", content: "Got the weather, now the math." },
        { type: "tool_start", toolName: "python", toolInput: { command: "print(2+2)" } },
        { type: "tool_result", content: "4\n", toolName: "python" },
      ],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupUser(userId);
  }
});

test("claude.ai import: thinking, tool_use and tool_result blocks are steps in order; flat text is the fallback body", async () => {
  const userId = await seedUser();
  const dir = await mkdtemp(path.join(tmpdir(), "openhorn-import-steps-"));
  try {
    const file = path.join(dir, "conversations.json");
    await writeFile(
      file,
      JSON.stringify([
        {
          uuid: "c1",
          name: "Chart request",
          model: "claude-sonnet-4-6",
          created_at: "2026-09-01T10:00:00Z",
          updated_at: "2026-09-01T10:05:00Z",
          chat_messages: [
            {
              uuid: "m1",
              sender: "human",
              text: "make a chart",
              content: [{ type: "text", text: "make a chart" }],
              created_at: "2026-09-01T10:00:00Z",
            },
            {
              uuid: "m2",
              sender: "assistant",
              text: "Let me build it.\nHere is your chart.",
              content: [
                { type: "thinking", thinking: "A bar chart fits." },
                { type: "text", text: "Let me build it." },
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "artifacts",
                  input: { command: "create", id: "chart", type: "text/html" },
                },
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  name: "artifacts",
                  content: [{ type: "text", text: "OK" }],
                  is_error: false,
                },
                { type: "text", text: "Here is your chart." },
              ],
              created_at: "2026-09-01T10:01:00Z",
            },
            {
              uuid: "m3",
              sender: "human",
              text: "thanks",
              content: [],
              created_at: "2026-09-01T10:02:00Z",
            },
            {
              uuid: "m4",
              sender: "assistant",
              text: "You're welcome.",
              created_at: "2026-09-01T10:03:00Z",
            },
          ],
        },
      ]),
    );

    const result = await importClaude(userId, file);
    expect(result.errors).toEqual([]);
    expect(result.messages.imported).toBe(4);
    const rows = await loadRows(userId);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ["user", "make a chart"],
      ["assistant", "Here is your chart."],
      ["user", "thanks"],
      ["assistant", "You're welcome."],
    ]);
    expect(rows[1].mode).toBe("agent");
    expect(rows[1].model).toBe("claude-sonnet-4-6");
    expect(JSON.parse(rows[1].agentRun ?? "null")).toEqual({
      status: "completed",
      summary: "Agent 已调用 1 个工具",
      toolCount: 1,
      steps: [
        { type: "thinking", content: "A bar chart fits." },
        { type: "reasoning", content: "Let me build it." },
        {
          type: "tool_start",
          toolName: "artifacts",
          toolInput: { command: "create", id: "chart", type: "text/html" },
          toolCallId: "toolu_1",
        },
        { type: "tool_result", content: "OK", toolName: "artifacts", toolCallId: "toolu_1" },
      ],
    });
    // A plain text reply stays a chat row with no run attached.
    expect(rows[3].mode).toBe("chat");
    expect(rows[3].agentRun).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanupUser(userId);
  }
});
