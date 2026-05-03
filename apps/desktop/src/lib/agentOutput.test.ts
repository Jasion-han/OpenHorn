import { describe, expect, test } from "bun:test";
import { resolveAgentDisplayOutput } from "./agentOutput";

describe("resolveAgentDisplayOutput", () => {
  test("prefers live message content while task is still running", () => {
    const result = resolveAgentDisplayOutput({
      messageContent: "正在逐步输出第一段内容",
      detailOutputText: "最终结果占位",
      isTerminal: false,
      isExecutionStreaming: true,
    });

    expect(result).toEqual({
      text: "正在逐步输出第一段内容",
      streaming: true,
      citations: undefined,
    });
  });

  test("falls back to detail output when live message content is not yet available", () => {
    const result = resolveAgentDisplayOutput({
      messageContent: "Thinking",
      detailOutputText: "这是从事件流里拼出的正文",
      isTerminal: false,
      isExecutionStreaming: true,
    });

    expect(result).toEqual({
      text: "这是从事件流里拼出的正文",
      streaming: true,
      citations: undefined,
    });
  });

  test("keeps completed message content as the primary display source", () => {
    const result = resolveAgentDisplayOutput({
      messageContent: "已经流式展示完的最终正文",
      detailOutputText: "另一份最终结果",
      isTerminal: true,
      isExecutionStreaming: false,
    });

    expect(result).toEqual({
      text: "已经流式展示完的最终正文",
      streaming: false,
      citations: undefined,
    });
  });

  test("uses detail output for historical fallback when message content is low signal", () => {
    const result = resolveAgentDisplayOutput({
      messageContent: "Done",
      detailOutputText: "历史会话里的正式最终结果",
      isTerminal: true,
      isExecutionStreaming: false,
    });

    expect(result).toEqual({
      text: "历史会话里的正式最终结果",
      streaming: false,
      citations: undefined,
    });
  });
});
