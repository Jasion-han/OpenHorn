import { describe, expect, test } from "bun:test";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { mapAcpUpdate, pickPermissionOption, readAcpUsage } from "./acp";
import type { AgentEvent } from "./events";

function notification(update: SessionUpdate, meta?: Record<string, unknown>): SessionNotification {
  return { sessionId: "sess_test", update, ...(meta ? { _meta: meta } : {}) };
}

/** Helper: flatten mapAcpUpdate result to an array for easier assertions. */
function flatMap(result: AgentEvent | AgentEvent[] | null): AgentEvent[] {
  if (result === null) return [];
  return Array.isArray(result) ? result : [result];
}

describe("mapAcpUpdate", () => {
  test("agent_message_chunk maps to a text delta", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      }),
    ).toEqual({ type: "text", content: "hello" });
  });

  test("non-text message chunk is dropped", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "aGk=", mimeType: "image/png" },
      }),
    ).toBe(null);
  });

  test("agent_thought_chunk maps to thinking", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hmm" },
      }),
    ).toEqual({ type: "thinking", content: "hmm" });
  });

  test("tool_call emits both tool_call_detail and legacy tool_start", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Run tests",
        kind: "execute",
        status: "pending",
        rawInput: { command: "bun test" },
      }),
    );
    expect(events.length).toBe(2);
    // First event: tool_call_detail
    expect(events[0].type).toBe("tool_call_detail");
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.toolCallId).toBe("call_1");
    expect(detail.title).toBe("Run tests");
    expect(detail.kind).toBe("execute");
    expect(detail.status).toBe("pending");
    expect(detail.rawInput).toEqual({ command: "bun test" });
    // Second event: legacy tool_start
    expect(events[1]).toEqual({
      type: "tool_start",
      toolName: "Run tests",
      toolInput: { command: "bun test" },
    });
  });

  test("tool_call without title falls back to kind", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_2",
        title: "",
        kind: "read",
      }),
    );
    expect(events.length).toBe(2);
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.title).toBe("read");
    expect(events[1]).toEqual({ type: "tool_start", toolName: "read", toolInput: undefined });
  });

  test("tool_call with diff content extracts the diff", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_diff",
        title: "Edit file",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/src/main.ts",
            oldText: "const x = 1;",
            newText: "const x = 2;",
          },
        ],
      }),
    );
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.diff).toEqual({
      path: "/src/main.ts",
      oldText: "const x = 1;",
      newText: "const x = 2;",
    });
  });

  test("tool_call with locations extracts them", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_loc",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/src/a.ts", line: 10 }, { path: "/src/b.ts" }],
      }),
    );
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.locations).toEqual([{ path: "/src/a.ts", line: 10 }, { path: "/src/b.ts" }]);
  });

  test("tool_call_update completed emits tool_call_detail + legacy tool_result", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "3 passed" } }],
      }),
    );
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("tool_call_detail");
    expect(events[1]).toEqual({ type: "tool_result", content: "3 passed" });
  });

  test("tool_call_update failed emits tool_call_detail + legacy tool_result", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_err",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
      }),
    );
    expect(events.length).toBe(2);
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.status).toBe("failed");
    expect(events[1]).toEqual({ type: "tool_result", content: "permission denied" });
  });

  test("tool_call_update in_progress emits tool_call_detail only (no legacy tool_result)", () => {
    const events = flatMap(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "in_progress",
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("tool_call_detail");
    const detail = events[0] as Extract<AgentEvent, { type: "tool_call_detail" }>;
    expect(detail.status).toBe("in_progress");
  });

  test("plan updates map to plan event with entries", () => {
    const result = mapAcpUpdate({
      sessionUpdate: "plan",
      entries: [
        { content: "step 1", priority: "high", status: "pending" },
        { content: "step 2", priority: "medium", status: "in_progress" },
      ],
    });
    expect(result).toEqual({
      type: "plan",
      entries: [
        { content: "step 1", priority: "high", status: "pending" },
        { content: "step 2", priority: "medium", status: "in_progress" },
      ],
    });
  });

  test("unknown update types are dropped, not errors", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "available_commands_update" as string,
      } as SessionUpdate),
    ).toBe(null);
  });
});

describe("readAcpUsage", () => {
  test("standard usage_update reports used as promptTokens with contextSize", () => {
    const usage = readAcpUsage(
      notification({ sessionUpdate: "usage_update", used: 5300, size: 200000 }),
    );
    expect(usage).toEqual({
      promptTokens: 5300,
      completionTokens: 0,
      contextSize: 200000,
    });
  });

  test("usage_update with cost includes cost", () => {
    const usage = readAcpUsage(
      notification({
        sessionUpdate: "usage_update",
        used: 5300,
        size: 200000,
        cost: { amount: 0.045, currency: "USD" },
      } as SessionUpdate),
    );
    expect(usage).toEqual({
      promptTokens: 5300,
      completionTokens: 0,
      contextSize: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
  });

  test("gemini private _meta.token_count wins with a real completion split", () => {
    const usage = readAcpUsage(
      notification(
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        { token_count: { input_tokens: 100, output_tokens: 40 } },
      ),
    );
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 40 });
  });

  test("plain message chunk carries no usage", () => {
    expect(
      readAcpUsage(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x" },
        }),
      ),
    ).toBe(null);
  });
});

describe("pickPermissionOption", () => {
  const options = [
    { optionId: "a", name: "Allow once", kind: "allow_once" },
    { optionId: "b", name: "Always allow", kind: "allow_always" },
    { optionId: "r", name: "Reject", kind: "reject_once" },
  ];

  test("allow picks allow_once first", () => {
    expect(pickPermissionOption(options, true)).toBe("a");
  });

  test("reject picks reject_once", () => {
    expect(pickPermissionOption(options, false)).toBe("r");
  });

  test("falls back to name matching when kind is missing (protocol dialect)", () => {
    const dialect = [
      { optionId: "x", name: "Allow this time" },
      { optionId: "y", name: "Deny" },
    ];
    expect(pickPermissionOption(dialect, true)).toBe("x");
    expect(pickPermissionOption(dialect, false)).toBe("y");
  });

  test("returns null when nothing matches", () => {
    expect(pickPermissionOption([], true)).toBe(null);
  });
});
