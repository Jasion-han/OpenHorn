import { describe, expect, test } from "bun:test";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { mapAcpUpdate, pickPermissionOption, readAcpUsage } from "./acp";

function notification(update: SessionUpdate, meta?: Record<string, unknown>): SessionNotification {
  return { sessionId: "sess_test", update, ...(meta ? { _meta: meta } : {}) };
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

  test("tool_call maps to tool_start with title and rawInput", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Run tests",
        kind: "execute",
        status: "pending",
        rawInput: { command: "bun test" },
      }),
    ).toEqual({ type: "tool_start", toolName: "Run tests", toolInput: { command: "bun test" } });
  });

  test("tool_call without title falls back to kind", () => {
    const event = mapAcpUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "",
      kind: "read",
    });
    expect(event).toEqual({ type: "tool_start", toolName: "read", toolInput: undefined });
  });

  test("tool_call_update completed maps to tool_result with content text", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "3 passed" } }],
      }),
    ).toEqual({ type: "tool_result", content: "3 passed" });
  });

  test("tool_call_update failed maps to tool_result", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_err",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "permission denied" } }],
      }),
    ).toEqual({ type: "tool_result", content: "permission denied" });
  });

  test("tool_call_update in_progress is dropped", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "in_progress",
      }),
    ).toBe(null);
  });

  test("plan updates are dropped, not errors", () => {
    expect(
      mapAcpUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "step 1", priority: "high", status: "pending" }],
      }),
    ).toBe(null);
  });
});

describe("readAcpUsage", () => {
  test("standard usage_update reports used as promptTokens", () => {
    const usage = readAcpUsage(
      notification({ sessionUpdate: "usage_update", used: 5300, size: 200000 }),
    );
    expect(usage).toEqual({ promptTokens: 5300, completionTokens: 0 });
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
