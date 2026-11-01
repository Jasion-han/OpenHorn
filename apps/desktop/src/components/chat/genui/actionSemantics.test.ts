import { describe, expect, test } from "bun:test";
import { createParser, evaluateRoot } from "@openuidev/lang-core";
import { offersFollowUp } from "./actionSemantics";
import { genUiLibrary } from "./library";

const schema = genUiLibrary.toJSONSchema();
const parser = createParser(schema, "Col");

/** The Button receives evaluated props, rather than the parser's raw action AST. */
function actionFor(expression?: string, label = "Action"): unknown {
  const source = `root=Button("${label}"${expression ? `,${expression}` : ""})\n$mode="fixed"`;
  const result = parser.parse(source);
  expect(result.meta.errors).toEqual([]);
  const root = evaluateRoot(result, {
    ctx: {
      getState: (name) => result.stateDeclarations[name],
      resolveRef: () => undefined,
      actions: schema.actions,
    },
    library: genUiLibrary,
    store: null,
  });
  expect(root?.typeName).toBe("Button");
  return root?.props.action;
}

describe("Button follow-up disclosure", () => {
  test("recognizes the real evaluated assistant plan and its explicit context", () => {
    const action = actionFor('@ToAssistant("Explain",{mode:$mode})');
    expect(action).toEqual({
      steps: [{ type: "continue_conversation", message: "Explain", context: { mode: "fixed" } }],
    });
    expect(offersFollowUp(action)).toBe(true);
  });

  test("recognizes a follow-up anywhere in a mixed action plan", () => {
    for (const expression of [
      'Action([@Set($mode,"principal"),@ToAssistant("Explain")])',
      'Action([@ToAssistant("Explain"),@Reset($mode)])',
    ]) {
      expect(offersFollowUp(actionFor(expression))).toBe(true);
    }
  });

  test("keeps the actionless and legacy implicit follow-ups visible", () => {
    for (const expression of [undefined, "{}", '{type:""}', '{type:"continue_conversation"}']) {
      expect(offersFollowUp(actionFor(expression))).toBe(true);
    }
  });

  test("local state, reset, clipboard and links do not offer a draft", () => {
    for (const expression of [
      '@Set($mode,"principal")',
      "@Reset($mode)",
      'Action([@Set($mode,"principal"),@Reset($mode)])',
      '@CopyToClipboard("Summary")',
      '@OpenUrl("https://example.com/repayment")',
      '{type:"open_url",url:"https://example.com/repayment"}',
    ]) {
      expect(offersFollowUp(actionFor(expression))).toBe(false);
    }
  });

  test("a button label cannot change the action's meaning", () => {
    expect(offersFollowUp(actionFor('@ToAssistant("Add a mode")', "切换为等额本金"))).toBe(true);
    expect(offersFollowUp(actionFor('@Set($mode,"principal")', "请 AI 分析"))).toBe(false);
  });

  test("empty or malformed plans never invent an assistant step", () => {
    expect(offersFollowUp({ steps: [] })).toBe(false);
    expect(offersFollowUp({ steps: [{ type: "unknown" }, null] })).toBe(false);
    expect(offersFollowUp({ steps: "invalid" })).toBe(false);
    expect(offersFollowUp("invalid")).toBe(false);
  });

  test("a falsey steps field still uses the runtime's fallback follow-up", () => {
    expect(offersFollowUp({ steps: null })).toBe(true);
    expect(offersFollowUp({ steps: undefined })).toBe(true);
  });
});
