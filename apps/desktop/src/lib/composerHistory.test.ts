import { describe, expect, test } from "bun:test";
import {
  buildComposerHistory,
  caretOnFirstLine,
  caretOnLastLine,
  navigateHistory,
  resetHistoryNav,
} from "./composerHistory";

describe("buildComposerHistory", () => {
  test("keeps user messages in send order and ignores assistant/system", () => {
    expect(
      buildComposerHistory([
        { role: "user", content: "one" },
        { role: "assistant", content: "reply" },
        { role: "system", content: "sys" },
        { role: "user", content: "two" },
      ]),
    ).toEqual(["one", "two"]);
  });

  test("trims and drops blank entries", () => {
    expect(
      buildComposerHistory([
        { role: "user", content: "  padded  " },
        { role: "user", content: "   " },
        { role: "user", content: "" },
      ]),
    ).toEqual(["padded"]);
  });

  test("collapses consecutive duplicates but keeps non-adjacent repeats", () => {
    expect(
      buildComposerHistory([
        { role: "user", content: "a" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "user", content: "a" },
      ]),
    ).toEqual(["a", "b", "a"]);
  });
});

describe("navigateHistory", () => {
  const history = ["oldest", "middle", "newest"];

  test("up from idle saves the draft and yields the newest entry", () => {
    const result = navigateHistory(resetHistoryNav(), history, "up", "typing");
    expect(result.text).toBe("newest");
    expect(result.state).toEqual({ index: 2, draft: "typing" });
  });

  test("repeated up walks older and stops at the oldest with no change", () => {
    let state = navigateHistory(resetHistoryNav(), history, "up", "").state;
    let result = navigateHistory(state, history, "up", "newest");
    expect(result.text).toBe("middle");
    state = result.state;
    result = navigateHistory(state, history, "up", "middle");
    expect(result.text).toBe("oldest");
    state = result.state;
    result = navigateHistory(state, history, "up", "oldest");
    expect(result.text).toBe(null);
    expect(result.state).toEqual({ index: 0, draft: "" });
  });

  test("down walks newer and past the newest restores the draft", () => {
    let state: ReturnType<typeof resetHistoryNav> = { index: 0, draft: "my draft" };
    let result = navigateHistory(state, history, "down", "oldest");
    expect(result.text).toBe("middle");
    state = result.state;
    result = navigateHistory(state, history, "down", "middle");
    expect(result.text).toBe("newest");
    state = result.state;
    result = navigateHistory(state, history, "down", "newest");
    expect(result.text).toBe("my draft");
    expect(result.state).toEqual({ index: null, draft: "" });
  });

  test("down while idle leaves the key to the browser", () => {
    const result = navigateHistory(resetHistoryNav(), history, "down", "typing");
    expect(result.text).toBe(null);
    expect(result.state).toEqual({ index: null, draft: "" });
  });

  test("up with empty history is a no-op", () => {
    const result = navigateHistory(resetHistoryNav(), [], "up", "typing");
    expect(result.text).toBe(null);
    expect(result.state).toEqual({ index: null, draft: "" });
  });

  test("editing resets navigation so the next up starts from the newest again", () => {
    const entered = navigateHistory(resetHistoryNav(), history, "up", "");
    expect(entered.state.index).toBe(2);
    const afterEdit = resetHistoryNav();
    const result = navigateHistory(afterEdit, history, "up", "edited text");
    expect(result.text).toBe("newest");
    expect(result.state).toEqual({ index: 2, draft: "edited text" });
  });
});

describe("caretOnFirstLine / caretOnLastLine", () => {
  test("single line is both first and last", () => {
    expect(caretOnFirstLine("hello", 3)).toBe(true);
    expect(caretOnLastLine("hello", 3)).toBe(true);
  });

  test("caret on the middle line of multi-line text is neither", () => {
    const value = "a\nb\nc";
    const caret = 2; // just before "b"
    expect(caretOnFirstLine(value, caret)).toBe(false);
    expect(caretOnLastLine(value, caret)).toBe(false);
  });

  test("caret at start of multi-line text is on the first line only", () => {
    const value = "a\nb\nc";
    expect(caretOnFirstLine(value, 0)).toBe(true);
    expect(caretOnLastLine(value, 0)).toBe(false);
  });

  test("caret at end of multi-line text is on the last line only", () => {
    const value = "a\nb\nc";
    expect(caretOnFirstLine(value, value.length)).toBe(false);
    expect(caretOnLastLine(value, value.length)).toBe(true);
  });
});
