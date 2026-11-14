import { expect, test } from "bun:test";
import { deepseekConversationId, prepareDeepSeekArchive } from "./deepseekImport";

const time = "2026-11-14T01:02:03.123456Z";
function entries(options: { fragments?: unknown[]; status?: string; cursor?: number } = {}) {
  const file = {
    id: "source",
    title: "",
    pinned: true,
    current_message_id: options.cursor ?? 2,
    inserted_at: time,
    updated_at: time,
    messages: [
      {
        id: 1,
        parent_id: null,
        role: "USER",
        status: "FINISHED",
        thinking_enabled: false,
        search_enabled: false,
        accumulated_token_usage: 0,
        inserted_at: time,
        fragments: [{ type: "REQUEST", content: "  exact user text  " }],
      },
      {
        id: 2,
        parent_id: 1,
        role: "ASSISTANT",
        status: options.status ?? "FINISHED",
        thinking_enabled: true,
        search_enabled: true,
        accumulated_token_usage: 0,
        inserted_at: time,
        fragments: options.fragments ?? [{ type: "RESPONSE", content: "  exact reply  " }],
      },
    ],
  };
  return new Map([
    ["manifest.json", Buffer.from(JSON.stringify({ export_format_version: 3 }))],
    [
      "chat_session_index.json",
      Buffer.from(
        JSON.stringify([
          {
            id: file.id,
            title: file.title,
            pinned: file.pinned,
            message_count: 2,
            inserted_at: time,
            updated_at: time,
          },
        ]),
      ),
    ],
    ["chat_sessions/source.json", Buffer.from(JSON.stringify(file))],
  ]);
}

test("preserves whitespace and microsecond timestamps to SQLite's supported Date precision", () => {
  const [conversation] = prepareDeepSeekArchive(entries());
  expect(conversation.title).toBe("");
  expect(conversation.isPinned).toBe(true);
  expect(conversation.createdAt.toISOString()).toBe("2026-11-14T01:02:03.123Z");
  expect(conversation.messages.map((m) => m.content)).toEqual([
    "  exact user text  ",
    "  exact reply  ",
  ]);
});

test("stops exactly at a user cursor, reporting all later messages outside that branch", () => {
  const [conversation] = prepareDeepSeekArchive(entries({ cursor: 1 }));
  expect(conversation.messages.map((m) => m.sourceId)).toEqual([1]);
  expect(conversation.warnings[0].includes("1 messages outside the current branch")).toBe(true);
});

test("refusal drops model response and thinking but retains template as a notice", () => {
  const [conversation] = prepareDeepSeekArchive(
    entries({
      status: "CONTENT_FILTER",
      fragments: [
        { type: "THINK", content: "private thought", elapsed_secs: null },
        { type: "RESPONSE", content: "filtered answer" },
        { type: "TEMPLATE_RESPONSE", content: "Refused" },
      ],
    }),
  );
  expect(conversation.messages[1].finishReason).toBe("refused");
  expect(conversation.messages[1].content).toBe("");
  expect(conversation.messages[1].steps).toEqual([{ type: "error", content: "Refused" }]);
});

test("unfinished and failed replies retain partial text with truthful finish reasons", () => {
  for (const [status, finishReason] of [
    ["WIP", "stopped"],
    ["INCOMPLETE", "stopped"],
    ["FAILED", "error"],
    ["TIMEOUT", "error"],
    ["CONTEXT_LENGTH_EXCEEDED", "error"],
  ] as const) {
    const [conversation] = prepareDeepSeekArchive(entries({ status }));
    expect(conversation.messages[1].finishReason).toBe(finishReason);
    expect(conversation.messages[1].content).toBe("  exact reply  ");
    expect(conversation.warnings.length > 0).toBe(true);
  }
});

test("maps search/open/find steps with stable call IDs and never invents unfinished results", () => {
  const [conversation] = prepareDeepSeekArchive(
    entries({
      fragments: [
        { type: "TOOL_SEARCH", queries: ["a", "b"], results: [], status: "WIP" },
        {
          type: "TOOL_OPEN",
          url: "https://example.com",
          title: "A",
          published_at: null,
          status: "FAILED",
        },
        { type: "TOOL_FIND", pattern: "needle", status: "NO_RESULT" },
      ],
    }),
  );
  const steps = conversation.messages[1].steps;
  expect(steps.map((s) => s.type)).toEqual([
    "tool_start",
    "tool_start",
    "error",
    "tool_start",
    "tool_result",
  ]);
  expect(
    steps[1].type === "tool_start" &&
      steps[2].type === "error" &&
      steps[1].toolCallId === steps[2].toolCallId,
  ).toBe(true);
});

test("does not inject opaque read-link signatures into model history or claim recovered body", () => {
  const [conversation] = prepareDeepSeekArchive(
    entries({
      fragments: [
        {
          type: "READ_LINK",
          results: [
            { url: "https://example.com", title: "Source", signature: "opaque-secret-signature" },
          ],
        },
      ],
    }),
  );
  expect(JSON.stringify(conversation).includes("opaque-secret-signature")).toBe(false);
  expect(conversation.warnings[0].includes("cannot be restored")).toBe(true);
});

test("rejects a tool fragment attached to a user message instead of silently losing it", () => {
  const archive = entries();
  const file = JSON.parse(archive.get("chat_sessions/source.json")?.toString() ?? "{}");
  file.messages[0].fragments.push({ type: "TOOL_SEARCH", queries: ["x"], results: [] });
  archive.set("chat_sessions/source.json", Buffer.from(JSON.stringify(file)));
  expect(() => prepareDeepSeekArchive(archive)).toThrow();
});

test("rejects canonically duplicated ZIP paths and unknown content instead of claiming complete import", () => {
  const archive = entries();
  archive.set("chat_sessions/source_files/caf\u00e9.png", Buffer.from("x"));
  archive.set("chat_sessions/source_files/cafe\u0301.png", Buffer.from("x"));
  expect(() => prepareDeepSeekArchive(archive)).toThrow();
  expect(() =>
    prepareDeepSeekArchive(entries({ fragments: [{ type: "UNKNOWN", content: "lost" }] })),
  ).toThrow();
});

test("source identity uses user and source session id, independent of archive bytes", () => {
  expect(deepseekConversationId("u1", "s1")).toBe(deepseekConversationId("u1", "s1"));
  expect(deepseekConversationId("u1", "s1") === deepseekConversationId("u2", "s1")).toBe(false);
  expect(deepseekConversationId("ab", "c") === deepseekConversationId("a", "bc")).toBe(false);
});

test("distinguishes present unsupported image bytes from missing originals", () => {
  const archive = entries({
    fragments: [
      {
        type: "FILE",
        files: [
          {
            id: "image",
            file_name: "image.png",
            file_size: 3,
            token_usage: null,
            inserted_at: time,
            export_path: "chat_sessions/source_files/image.png",
            is_image: true,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  });
  archive.set("chat_sessions/source_files/image.png", Buffer.from("bad"));
  const [conversation] = prepareDeepSeekArchive(archive);
  expect(conversation.messages[1].attachments[0].unavailableReason).toBe("unsupported");
});

test("rejects an empty attachment path instead of treating it as missing metadata", () => {
  const archive = entries({
    fragments: [
      {
        type: "FILE",
        files: [
          {
            id: "image",
            file_name: "image.png",
            file_size: 3,
            token_usage: null,
            inserted_at: time,
            export_path: "",
            is_image: true,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  });
  expect(() => prepareDeepSeekArchive(archive)).toThrow();
});
