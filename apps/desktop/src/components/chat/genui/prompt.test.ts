import { describe, expect, test } from "bun:test";
import { createParser } from "@openuidev/react-lang";
import { withGenUiMessages, withGenUiPrompt } from "../../../lib/genui/promptMerge";
import { OPENUI_EXAMPLES } from "../../../lib/genui/promptText";
import { iconFor } from "./components";
import { genUiLibrary } from "./library";
import { buildGenUiSystemPrompt } from "./prompt";

// OpenUI 1.0 built-ins plus the action steps; everything else must be a
// library function, or the model is being taught a name that does not exist.
const BUILTINS = [
  "Count",
  "First",
  "Last",
  "Sum",
  "Avg",
  "Min",
  "Max",
  "Sort",
  "Filter",
  "Round",
  "Abs",
  "Floor",
  "Ceil",
  "Each",
  "Set",
  "Reset",
  "ToAssistant",
  "OpenUrl",
];

describe("prompt examples", () => {
  const parser = createParser(genUiLibrary.toJSONSchema(), "Col");

  test("the parser reports components the library does not have", () => {
    const result = parser.parse('root = Col([Nope("x"), Title("ok")])');
    expect(result.meta.errors.length > 0).toBe(true);
  });

  for (const [index, program] of OPENUI_EXAMPLES.entries()) {
    test(`example ${index + 1} parses cleanly against the library`, () => {
      const result = parser.parse(program);
      expect(result.root === null).toBe(false);
      expect(result.meta.errors).toEqual([]);
      expect(result.meta.unresolved).toEqual([]);
      expect(result.meta.orphaned).toEqual([]);
      expect(result.meta.incomplete).toBe(false);
    });

    test(`example ${index + 1} only calls functions that exist`, () => {
      const known = new Set([
        ...BUILTINS,
        ...Object.keys(genUiLibrary.functions ?? {}),
        ...Object.keys(genUiLibrary.actions ?? {}),
      ]);
      const used = [...program.matchAll(/@([A-Z]\w*)/g)].map((m) => m[1] ?? "");
      expect(used.filter((name) => !known.has(name))).toEqual([]);
    });
  }
});

describe("buildGenUiSystemPrompt", () => {
  const prompt = buildGenUiSystemPrompt();

  test("replaces the whole-response-is-code framing with inline blocks", () => {
    expect(prompt.includes("Your ENTIRE response must be valid openui-lang")).toBe(false);
    expect(prompt.includes("```openui-lang")).toBe(true);
    expect(prompt.includes("```html-ui")).toBe(true);
  });

  test("lists every component and library function", () => {
    for (const name of Object.keys(genUiLibrary.components)) {
      expect(prompt.includes(`${name}(`)).toBe(true);
    }
    for (const name of Object.keys(genUiLibrary.functions ?? {})) {
      expect(prompt.includes(`@${name}(`)).toBe(true);
    }
  });
});

describe("withGenUiPrompt", () => {
  test("leaves the prompt untouched when disabled", () => {
    expect(withGenUiPrompt("base", null)).toBe("base");
    expect(withGenUiPrompt(undefined, null)).toBe(undefined);
  });

  test("appends the section after the base prompt", () => {
    const merged = withGenUiPrompt("base", buildGenUiSystemPrompt()) ?? "";
    expect(merged.startsWith("base\n\n")).toBe(true);
    expect(merged.endsWith(buildGenUiSystemPrompt())).toBe(true);
  });

  test("uses the section alone without a base prompt", () => {
    expect(withGenUiPrompt("  ", buildGenUiSystemPrompt())).toBe(buildGenUiSystemPrompt());
  });
});

describe("withGenUiMessages", () => {
  test("appends to the first system message", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const merged = withGenUiMessages(messages, "section");
    expect(merged).toHaveLength(2);
    expect(String(merged[0]?.content).startsWith("sys\n\n")).toBe(true);
    expect(messages[0]?.content).toBe("sys");
  });

  test("adds a system message when there is none", () => {
    const merged = withGenUiMessages([{ role: "user", content: "hi" }], "section");
    expect(merged).toHaveLength(2);
    expect(merged[0]?.role).toBe("system");
  });

  test("returns the same array when disabled", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(withGenUiMessages(messages, null) === messages).toBe(true);
  });
});

describe("iconFor", () => {
  test("resolves canonical names and older aliases", () => {
    expect(iconFor("circle-check") === null).toBe(false);
    expect(iconFor("check-circle") === null).toBe(false);
    expect(iconFor("map-pin") === null).toBe(false);
  });

  test("returns null for unknown names and non-icon exports", () => {
    expect(iconFor("definitely-not-an-icon")).toBe(null);
    expect(iconFor("create-lucide-icon")).toBe(null);
    expect(iconFor("")).toBe(null);
  });
});

describe("prompt size", () => {
  // Chat-mode regenerate / edit forward the section as `appendSystemPrompt`;
  // the server rejects anything over APPEND_SYSTEM_PROMPT_MAX_LENGTH
  // (apps/server/src/services/appendSystemPrompt.ts) with a 400.
  test("stays under the server's appendSystemPrompt cap", () => {
    expect(buildGenUiSystemPrompt().trim().length < 32_000).toBe(true);
  });
});
