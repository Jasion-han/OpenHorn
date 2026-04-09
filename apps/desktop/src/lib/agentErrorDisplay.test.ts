import { describe, expect, test } from "bun:test";
import { formatStructuredAgentError, normalizeAgentDisplayText } from "./agentErrorDisplay";

describe("normalizeAgentDisplayText", () => {
  test("preserves raw upstream english provider errors", () => {
    expect(
      normalizeAgentDisplayText(
        "OpenAI API error (403): token quota is not enough for this request.",
        { errorCode: "quota_exhausted", retryable: true },
      ),
    ).toBe("OpenAI API error (403): token quota is not enough for this request.");
  });

  test("preserves execution-failed wrapper as-is when content is upstream english", () => {
    expect(
      normalizeAgentDisplayText(
        "Execution failed: OpenAI API error (403): token quota is not enough for this request.",
      ),
    ).toBe("Execution failed: OpenAI API error (403): token quota is not enough for this request.");
  });

  test("uses structured chinese error when no raw content exists", () => {
    expect(
      normalizeAgentDisplayText("", { errorCode: "protocol_incompatible", retryable: false }),
    ).toBe("当前渠道不兼容 Agent 运行协议");
  });

  test("appends retry hint via structured dictionary", () => {
    expect(normalizeAgentDisplayText("", { errorCode: "timeout", retryable: true })).toBe(
      "连接或响应超时，可稍后重试",
    );
  });

  test("returns null when neither raw nor structured content is available", () => {
    expect(normalizeAgentDisplayText(null)).toBe(null);
    expect(normalizeAgentDisplayText("")).toBe(null);
    expect(normalizeAgentDisplayText("   ")).toBe(null);
  });

  test("never invents text by string-matching English content", () => {
    // Previously this string was hard-translated to "执行失败：模型未返回有效结果".
    // Under the new policy we surface the real upstream string and leave
    // translation responsibility to the i18n dictionary keyed on errorCode.
    expect(normalizeAgentDisplayText("Execution failed: model returned no valid result")).toBe(
      "Execution failed: model returned no valid result",
    );
  });
});

describe("formatStructuredAgentError", () => {
  test("returns null when no errorCode is provided", () => {
    expect(formatStructuredAgentError(undefined)).toBe(null);
  });

  test("returns the dictionary entry when errorCode is present", () => {
    expect(formatStructuredAgentError("auth_failed", false)).toBe("鉴权失败");
  });

  test("appends retry hint when retryable is true", () => {
    expect(formatStructuredAgentError("auth_failed", true)).toBe("鉴权失败，可稍后重试");
  });
});
