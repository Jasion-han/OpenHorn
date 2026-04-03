import { expect, test } from "bun:test";
import type {
  ChatResponse,
  StreamingToolCallingAdapter,
  ToolCallingOptions,
  ToolCallingStreamEvent,
} from "../agent-adapters";
import { runGenericAgentRuntime } from "./genericAgentRuntime";

class FakeToolCallingAdapter implements StreamingToolCallingAdapter {
  constructor(
    private readonly turns: Array<{
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      finishReason?: string | null;
      stream?: ToolCallingStreamEvent[];
    }>,
  ) {}

  async chat(): Promise<ChatResponse> {
    throw new Error("not used");
  }

  async *chatStream() {
    throw new Error("not used");
  }

  async runToolCallingTurn(_options: ToolCallingOptions) {
    this.calls.push(_options);
    const next = this.turns.shift();
    if (!next) {
      return { text: "", toolCalls: [], finishReason: "stop" };
    }
    return {
      text: next.text,
      toolCalls: next.toolCalls,
      finishReason: next.finishReason ?? null,
    };
  }

  async *runToolCallingTurnStream(_options: ToolCallingOptions) {
    this.calls.push(_options);
    const next = this.turns.shift();
    if (!next) {
      yield {
        type: "done",
        result: { text: "", toolCalls: [], finishReason: "stop" },
      };
      return;
    }

    for (const event of next.stream ?? []) {
      yield event;
    }

    yield {
      type: "done",
      result: {
        text: next.text,
        toolCalls: next.toolCalls,
        finishReason: next.finishReason ?? null,
      },
    };
  }

  readonly calls: ToolCallingOptions[] = [];
}

test("runGenericAgentRuntime executes tool call then returns final text", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "",
      toolCalls: [{ id: "call-1", name: "bash", input: { command: "printf 'ok'" } }],
      finishReason: "tool_calls",
    },
    {
      text: "finished",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const events = [];
  for await (const event of runGenericAgentRuntime({
    adapter,
    model: "gpt-test",
    prompt: "run a command",
    cwd: process.cwd(),
  })) {
    events.push(event);
  }

  expect(events[0]).toEqual({ type: "meta" });
  expect(events[1]).toMatchObject({
    type: "tool_start",
    toolName: "Bash",
  });
  expect(events[2]).toMatchObject({
    type: "tool_result",
    toolName: "Bash",
  });
  expect(events[3]).toEqual({ type: "meta" });
  expect(events[4]).toEqual({ type: "text", content: "finished", streamed: false });
});

test("runGenericAgentRuntime emits interim text before executing tool calls", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "Checking the workspace now.",
      toolCalls: [{ id: "call-1", name: "bash", input: { command: "printf 'ok'" } }],
      finishReason: "tool_calls",
    },
    {
      text: "finished",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const events = [];
  for await (const event of runGenericAgentRuntime({
    adapter,
    model: "gpt-test",
    prompt: "run a command",
    cwd: process.cwd(),
  })) {
    events.push(event);
  }

  expect(events[0]).toEqual({ type: "meta" });
  expect(events[1]).toEqual({ type: "thought", content: "Checking the workspace now." });
  expect(events[2]).toMatchObject({
    type: "tool_start",
    toolName: "Bash",
  });
  expect(events[3]).toMatchObject({
    type: "tool_result",
    toolName: "Bash",
  });
  expect(events[4]).toEqual({ type: "meta" });
  expect(events[5]).toEqual({ type: "text", content: "finished", streamed: false });
});

test("runGenericAgentRuntime returns direct final answer when no tool call exists", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "done directly",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const events = [];
  for await (const event of runGenericAgentRuntime({
    adapter,
    model: "gpt-test",
    prompt: "hello",
    cwd: process.cwd(),
  })) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: "meta" },
    { type: "text", content: "done directly", streamed: false },
  ]);
});

test("runGenericAgentRuntime streams direct final text when adapter supports it", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "done directly",
      toolCalls: [],
      finishReason: "stop",
      stream: [
        { type: "text_delta", content: "done " },
        { type: "text_delta", content: "directly" },
      ],
    },
  ]);

  const events = [];
  for await (const event of runGenericAgentRuntime({
    adapter,
    model: "gpt-test",
    prompt: "hello",
    cwd: process.cwd(),
  })) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: "meta" },
    { type: "text_delta", content: "done " },
    { type: "text_delta", content: "directly" },
    { type: "text", content: "done directly", streamed: true },
  ]);
});

test("runGenericAgentRuntime resets provisional streamed text when tool calls start", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "Checking now",
      toolCalls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
      finishReason: "tool_calls",
      stream: [
        { type: "text_delta", content: "Checking " },
        { type: "text_delta", content: "now" },
        { type: "tool_call_delta" },
      ],
    },
    {
      text: "finished",
      toolCalls: [],
      finishReason: "stop",
    },
  ]);

  const events = [];
  for await (const event of runGenericAgentRuntime({
    adapter,
    model: "gpt-test",
    prompt: "run a command",
    cwd: process.cwd(),
  })) {
    events.push(event);
  }

  expect(events[0]).toEqual({ type: "meta" });
  expect(events[1]).toEqual({ type: "text_delta", content: "Checking " });
  expect(events[2]).toEqual({ type: "text_delta", content: "now" });
  expect(events[3]).toEqual({ type: "text_reset" });
  expect(events[4]).toEqual({ type: "thought", content: "Checking now" });
  expect(events[5]).toMatchObject({ type: "tool_start", toolName: "Bash" });
});

test("runGenericAgentRuntime stops after max turn budget", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "",
      toolCalls: [{ id: "call-1", name: "bash", input: { command: "printf '1'" } }],
      finishReason: "tool_calls",
    },
    {
      text: "",
      toolCalls: [{ id: "call-2", name: "bash", input: { command: "printf '2'" } }],
      finishReason: "tool_calls",
    },
  ]);

  await expect(async () => {
    for await (const _event of runGenericAgentRuntime({
      adapter,
      model: "gpt-test",
      prompt: "loop",
      cwd: process.cwd(),
      maxTurns: 1,
    })) {
      // consume
    }
  }).toThrow("超过最大工具调用轮数");
});

test("runGenericAgentRuntime forces bash tool choice for workspace-grounded first turns", async () => {
  const adapter = new FakeToolCallingAdapter([
    {
      text: "",
      toolCalls: [{ id: "call-1", name: "bash", input: { command: "cat README.md" } }],
      finishReason: "tool_calls",
    },
  ]);

  await expect(async () => {
    for await (const _event of runGenericAgentRuntime({
      adapter,
      model: "gpt-test",
      prompt: "Read README.md and summarize the repository.",
      cwd: process.cwd(),
      maxTurns: 1,
    })) {
      // consume
    }
  }).toThrow("超过最大工具调用轮数");

  expect(adapter.calls[0]?.toolChoice).toEqual({ type: "tool", name: "bash" });
});
