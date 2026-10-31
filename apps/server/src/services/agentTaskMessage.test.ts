import { describe, expect, test } from "bun:test";
import { selectTaskFailure, selectTaskReplyText } from "./agentTaskMessage";

describe("selectTaskReplyText", () => {
  const long = "x".repeat(5000);

  test("returns the full final_result of the latest execution run, never clipped", () => {
    const runs = [
      { id: "exec-2", phase: "execution" },
      { id: "plan-1", phase: "planning" },
      { id: "exec-1", phase: "execution" },
    ];
    const artifacts = [
      { runId: "exec-1", type: "final_result", content: "older answer" },
      { runId: "exec-2", type: "execution_summary", content: "summary" },
      { runId: "exec-2", type: "final_result", content: `  ${long}  ` },
    ];
    expect(selectTaskReplyText(runs, artifacts)).toBe(long);
  });

  test("falls back to the newest final_result when the latest run produced none", () => {
    const runs = [
      { id: "exec-2", phase: "execution" },
      { id: "exec-1", phase: "execution" },
    ];
    const artifacts = [{ runId: "exec-1", type: "final_result", content: "older answer" }];
    expect(selectTaskReplyText(runs, artifacts)).toBe("older answer");
  });

  test("is empty without a final_result", () => {
    expect(selectTaskReplyText([{ id: "p", phase: "planning" }], [])).toBe("");
  });
});

describe("selectTaskFailure", () => {
  const runs = [
    { id: "exec-2", phase: "execution", error: " boom " },
    { id: "exec-1", phase: "execution", error: "old" },
  ];

  test("returns the latest execution error of a failed task", () => {
    expect(selectTaskFailure("failed", runs)).toBe("boom");
  });

  test("is undefined for tasks that did not fail", () => {
    expect(selectTaskFailure("completed", runs)).toBeUndefined();
    expect(selectTaskFailure("failed", [{ id: "p", phase: "planning", error: null }])).toBe(
      undefined,
    );
  });
});
