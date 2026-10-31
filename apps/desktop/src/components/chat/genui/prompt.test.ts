import { describe, expect, test } from "bun:test";
import { createParser } from "@openuidev/react-lang";
import { withGenUiMessages, withGenUiPrompt } from "../../../lib/genui/promptMerge";
import { OPENUI_EXAMPLES, OPENUI_RULES } from "../../../lib/genui/promptText";
import {
  computedStateNames,
  renameStateRefs,
  repairComputedState,
} from "../../../lib/genui/stateCheck";
import { iconFor, numberText } from "./components";
import { NANO_MORTGAGE } from "./fixtures/nanoMortgage";
import { renderableProgram } from "./GenUiBlock";
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

// A number, string, boolean, null, or a [...] / {...} literal.
const LITERAL_DEFAULT = /^(-?\d+(\.\d+)?|"[^"]*"|true|false|null|\[.*\]|\{.*\})$/;

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
      expect(computedStateNames(result.stateDeclarations)).toEqual([]);
    });

    test(`example ${index + 1} gives every $variable a literal default`, () => {
      const computed = program
        .split("\n")
        .map((line) => line.match(/^(\$\w+)\s*=\s*(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .filter(([, , value]) => !LITERAL_DEFAULT.test((value ?? "").trim()))
        .map(([, name]) => name);
      expect(computed).toEqual([]);
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

describe("local interactions", () => {
  const mortgage = OPENUI_EXAMPLES.find((program) => program.includes("SegmentedControl")) ?? "";

  test("an example switches a mode with a SegmentedControl bound to a declared $variable", () => {
    const bound = mortgage.match(/SegmentedControl\((\$\w+),/)?.[1] ?? "";
    expect(bound.length > 0).toBe(true);
    expect(new RegExp(`^\\${bound} = "[^"]*"$`, "m").test(mortgage)).toBe(true);
    expect(mortgage.includes(`${bound} == `)).toBe(true);
  });

  test("the mode switch never goes through @ToAssistant", () => {
    const followUps = [...mortgage.matchAll(/@ToAssistant\("([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(followUps).toHaveLength(1);
    expect(followUps.some((text) => text.includes("等额本金"))).toBe(false);
  });

  test("the parser keeps computed $variable defaults as expressions", () => {
    const parser = createParser(genUiLibrary.toJSONSchema(), "Col");
    const result = parser.parse(
      [
        'root = Col([Stat("a", @Format($m, "currency", 0)), Stat("b", $p), Text($mode)])',
        "$years = 30",
        "$p = $years * 12",
        "$m = @Payment(1000, 3.5, $p)",
        '$mode = "a"',
        "$list = [1, 2]",
        "$o = {a: 1}",
      ].join("\n"),
    );
    expect(result.meta.errors).toEqual([]);
    expect(computedStateNames(result.stateDeclarations)).toEqual(["$p", "$m"]);
  });

  test("the rules forbid computed $variables and @ToAssistant for local switches", () => {
    const prompt = buildGenUiSystemPrompt();
    for (const rule of OPENUI_RULES) expect(prompt.includes(rule)).toBe(true);
    expect(prompt.includes("A value computed from others is a plain name without $")).toBe(true);
    expect(prompt.includes("Never use @ToAssistant for that")).toBe(true);
    expect(prompt.includes("never through sendPrompt")).toBe(true);
  });
});

// lang-core is react-lang's dependency, not the app's: resolve it from there.
// Its evaluator computes a value the way the Renderer does.
type Ast = { k?: string; args?: Ast[] } & Record<string, unknown>;
type LangCore = { evaluate: (node: unknown, ctx: Record<string, unknown>) => unknown };
declare const Bun: { resolveSync: (id: string, from: string) => string };

async function loadLangCore(): Promise<LangCore> {
  const reactLang = Bun.resolveSync(
    "@openuidev/react-lang",
    (import.meta as { dir?: string }).dir ?? ".",
  );
  const path = Bun.resolveSync(
    "@openuidev/lang-core",
    reactLang.slice(0, reactLang.lastIndexOf("/")),
  );
  return (await import(path)) as LangCore;
}

function findElements(node: unknown, typeName: string, found: Ast[] = []): Ast[] {
  if (!node || typeof node !== "object") return found;
  if ((node as { typeName?: unknown }).typeName === typeName) found.push(node as Ast);
  for (const value of Object.values(node)) findElements(value, typeName, found);
  return found;
}

describe("computed $variable repair", () => {
  const parser = createParser(genUiLibrary.toJSONSchema(), "Col");
  const repair = (source: string) => repairComputedState(source, (text) => parser.parse(text));

  test("the real model output has computed $variables before repair", () => {
    const names = computedStateNames(parser.parse(NANO_MORTGAGE).stateDeclarations);
    expect(names.includes("$months")).toBe(true);
    expect(names.includes("$monthlyPaymentA")).toBe(true);
    // Arrays of expressions are computed too.
    expect(names.includes("$seriesB")).toBe(true);
  });

  test("after repair no $variable defaults to an expression and the program is clean", () => {
    const repaired = repair(NANO_MORTGAGE);
    const result = parser.parse(repaired);
    expect(computedStateNames(result.stateDeclarations)).toEqual([]);
    expect(result.meta.errors).toEqual([]);
    expect(result.root === null).toBe(false);
    // User inputs keep their names, so saved block state still applies.
    for (const name of ["$mode", "$amount", "$rate", "$years"]) {
      expect(name in result.stateDeclarations).toBe(true);
    }
    expect(repaired.includes("months = $years * 12")).toBe(true);
    expect(repaired.includes("$months")).toBe(false);
  });

  test("derived values compute for both modes", async () => {
    const core = await loadLangCore();
    const result = parser.parse(repair(NANO_MORTGAGE));
    const schema = genUiLibrary.toJSONSchema() as { functions?: Record<string, object> };
    const functions = Object.fromEntries(
      Object.entries(genUiLibrary.functions ?? {}).map(([name, fn]) => [
        name,
        { ...(schema.functions?.[name] ?? {}), fn: fn.fn },
      ]),
    );
    // The Stat values (monthly / first-month payment, total interest) in one mode.
    const statValues = (mode: string) => {
      const state: Record<string, unknown> = { ...result.stateDeclarations, $mode: mode };
      const ctx = {
        getState: (name: string) => state[name],
        resolveRef: () => undefined,
        functions,
      };
      return findElements(result.root, "Stat").map((stat) => {
        const value = (stat.props as { value?: Ast }).value;
        return Number(core.evaluate(value?.args?.[0], ctx));
      });
    };
    const fixed = statValues("等额本息");
    const declining = statValues("等额本金");
    expect(fixed).toHaveLength(2);
    expect(fixed.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    expect(declining.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    // 1,000,000 at 3.5% over 30 years.
    expect(Math.round(fixed[0] ?? 0)).toBe(4490);
    expect(Math.round(declining[0] ?? 0)).toBe(5694);
  });

  test("leaves strings and comments alone", () => {
    const source = [
      "$x = $y + 1 // uses $x",
      'a = Text("$x stays", \'and $x here\', "esc \\" $x")',
      "# $x in a hash comment",
      "b = $x",
    ].join("\n");
    expect(renameStateRefs(source, ["$x"])).toBe(
      [
        "x = $y + 1 // uses $x",
        'a = Text("$x stays", \'and $x here\', "esc \\" $x")',
        "# $x in a hash comment",
        "b = x",
      ].join("\n"),
    );
  });

  test("does not touch longer names sharing a prefix", () => {
    expect(renameStateRefs("$r = $rate / 1200\nv = $r * $rate + $r_2", ["$r"])).toBe(
      "r = $rate / 1200\nv = r * $rate + $r_2",
    );
  });

  test("renames around a plain name that is already declared", () => {
    const source = "months = 3\n$months = $years * 12\nroot = Col([Text(months), Text($months)])";
    expect(renameStateRefs(source, ["$months"])).toBe(
      "months = 3\nmonths_ = $years * 12\nroot = Col([Text(months), Text(months_)])",
    );
  });

  test("never renames to a literal keyword", () => {
    expect(renameStateRefs("$null = $a + 1\nb = $null", ["$null"])).toBe(
      "null_ = $a + 1\nb = null_",
    );
  });

  test("two computed names that lower-case alike get distinct names", () => {
    expect(renameStateRefs("$Total = $a + 1\n$total = $a + 2", ["$Total", "$total"])).toBe(
      "total = $a + 1\ntotal_ = $a + 2",
    );
  });

  test("repairs only complete blocks", () => {
    expect(renderableProgram(NANO_MORTGAGE, true)).toBe(NANO_MORTGAGE);
    expect(renderableProgram(NANO_MORTGAGE, false)).toBe(repair(NANO_MORTGAGE));
    const clean = OPENUI_EXAMPLES[0] ?? "";
    expect(renderableProgram(clean, false)).toBe(clean);
  });
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

describe("numberText", () => {
  test("prints strings unchanged and formats finite numbers", () => {
    expect(numberText("12 km")).toBe("12 km");
    expect(numberText(1234.567)).toBe((1234.57).toLocaleString("zh-CN"));
    expect(numberText(true)).toBe("true");
    expect(numberText(false)).toBe("false");
  });

  test("renders non-scalars empty instead of [object Object]", () => {
    expect(numberText({ type: "binary", op: "+" })).toBe("");
    expect(numberText([1, 2])).toBe("");
    expect(numberText(null)).toBe("");
    expect(numberText(undefined)).toBe("");
    expect(numberText(Number.NaN)).toBe("");
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
