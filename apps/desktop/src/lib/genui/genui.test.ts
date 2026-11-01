import { describe, expect, test } from "bun:test";
import { createGenUiStore, GEN_UI_STORAGE_KEY } from "../../stores/genUiStore";
import {
  type BlockStateStorage,
  blockStateKey,
  loadBlockState,
  MAX_ENTRIES,
  saveBlockState,
} from "./blockState";
import { endsInsideOpenFence, genUiKindOf } from "./fence";
import { Format, Includes, Payment, Range, Toggle } from "./functions";
import { extractCompleteStyles, processPartialHtml } from "./partialHtml";
import {
  buildPreviewDocument,
  buildSandboxDocument,
  MAX_FRAME_HEIGHT,
  MAX_LINK_LENGTH,
  MAX_PROMPT_LENGTH,
  MESSAGE_TYPE,
  MIN_FRAME_HEIGHT,
  parseBridgeMessage,
  SANDBOX_CSP,
  safeWebUrl,
  type ThemeSnapshot,
} from "./sandbox";

function memoryStorage(): BlockStateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("genUiKindOf", () => {
  test("recognizes the two block languages", () => {
    expect(genUiKindOf("openui-lang")).toBe("openui");
    expect(genUiKindOf("OpenUI")).toBe("openui");
    expect(genUiKindOf("html-ui")).toBe("html");
  });

  test("leaves ordinary code fences alone", () => {
    expect(genUiKindOf("html")).toBe(null);
    expect(genUiKindOf("tsx")).toBe(null);
    expect(genUiKindOf(undefined)).toBe(null);
  });
});

describe("endsInsideOpenFence", () => {
  test("is true while the last fence is unclosed", () => {
    expect(endsInsideOpenFence("intro\n```openui-lang\nroot = Col([])")).toBe(true);
  });

  test("is false once the fence closes", () => {
    expect(endsInsideOpenFence("```openui-lang\nroot = Col([])\n```\ndone")).toBe(false);
  });

  test("needs a closing fence at least as long, without an info string", () => {
    expect(endsInsideOpenFence("````html-ui\n<p>x</p>\n```")).toBe(true);
    expect(endsInsideOpenFence("```html-ui\n<p>x</p>\n```js")).toBe(true);
    expect(endsInsideOpenFence("````html-ui\n<p>x</p>\n````")).toBe(false);
  });

  test("tracks several blocks", () => {
    expect(endsInsideOpenFence("```a\n1\n```\ntext\n```b\n2")).toBe(true);
    expect(endsInsideOpenFence("```a\n1\n```\n```b\n2\n```")).toBe(false);
  });
});

describe("processPartialHtml", () => {
  test("drops scripts, complete or not", () => {
    expect(processPartialHtml("<p>a</p><script>alert(1)</script>")).toBe("<p>a</p>");
    expect(processPartialHtml("<p>a</p><script>let x = 1")).toBe("<p>a</p>");
  });

  test("drops a half-written trailing tag", () => {
    expect(processPartialHtml("<p>a</p><scr")).toBe("<p>a</p>");
    expect(processPartialHtml('<div class="x')).toBe("");
  });

  test("drops a trailing partial entity", () => {
    expect(processPartialHtml("<p>a &am")).toBe("<p>a ");
  });

  test("keeps only the body when there is one", () => {
    expect(processPartialHtml("<head><title>t</title></head><body><p>a</p></body>")).toBe(
      "<p>a</p>",
    );
  });

  test("collects complete style blocks for the preview head", () => {
    const html = "<style>p{color:red}</style><p>a</p><style>div{";
    expect(extractCompleteStyles(html)).toBe("<style>p{color:red}</style>");
  });
});

const theme: ThemeSnapshot = { dark: true, variables: { "--foreground": "0 0% 98%" } };

describe("sandbox documents", () => {
  test("the trusted bootstrap contains no model markup and starts after the CSP", () => {
    const doc = buildSandboxDocument(theme);
    const cspAt = doc.indexOf("Content-Security-Policy");
    const runtimeAt = doc.indexOf("<script>");
    expect(cspAt > -1 && cspAt < runtimeAt).toBe(true);
    expect(doc.includes("evil.test")).toBe(false);
    expect(doc.includes(SANDBOX_CSP)).toBe(true);
  });

  test("the CSP denies everything not listed", () => {
    expect(SANDBOX_CSP.startsWith("default-src 'none'")).toBe(true);
    expect(SANDBOX_CSP.includes("connect-src https://cdn.jsdelivr.net")).toBe(true);
    expect(SANDBOX_CSP.includes("form-action 'none'")).toBe(true);
  });

  test("the preview document allows no script at all", () => {
    const doc = buildPreviewDocument("", "<p>x</p>", theme);
    expect(doc.includes("script-src")).toBe(false);
    expect(doc.includes("default-src 'none'")).toBe(true);
  });

  test("theme variables and color scheme are injected", () => {
    const doc = buildSandboxDocument(theme);
    expect(doc.includes("--foreground:0 0% 98%;")).toBe(true);
    expect(doc.includes("color-scheme:dark")).toBe(true);
  });
});

describe("parseBridgeMessage", () => {
  const msg = (data: Record<string, unknown>) =>
    parseBridgeMessage({ type: MESSAGE_TYPE, ...data });

  test("ignores foreign and malformed messages", () => {
    expect(parseBridgeMessage({ type: "other", action: "height", height: 100 })).toBe(null);
    expect(parseBridgeMessage("height")).toBe(null);
    expect(parseBridgeMessage(null)).toBe(null);
    expect(msg({ action: "eval", code: "1" })).toBe(null);
    expect(msg({ action: "height", height: "100" })).toBe(null);
    expect(msg({ action: "height", height: Number.NaN })).toBe(null);
  });

  test("clamps heights", () => {
    expect(msg({ action: "height", height: 10 })).toEqual({
      action: "height",
      height: MIN_FRAME_HEIGHT,
    });
    expect(msg({ action: "height", height: 99999 })).toEqual({
      action: "height",
      height: MAX_FRAME_HEIGHT,
    });
  });

  test("trims and caps follow-up text, and rejects empty text", () => {
    expect(msg({ action: "sendPrompt", text: "  hi  " })).toEqual({
      action: "sendPrompt",
      text: "hi",
    });
    const long = msg({ action: "sendPrompt", text: "x".repeat(MAX_PROMPT_LENGTH + 50) });
    expect(long?.action === "sendPrompt" ? long.text.length : 0).toBe(MAX_PROMPT_LENGTH);
    expect(msg({ action: "sendPrompt", text: "   " })).toBe(null);
    expect(msg({ action: "sendPrompt", text: 42 })).toBe(null);
  });

  test("opens only http(s) links", () => {
    expect(msg({ action: "openLink", url: "https://example.com/a" })).toEqual({
      action: "openLink",
      url: "https://example.com/a",
    });
    expect(msg({ action: "openLink", url: "javascript:alert(1)" })).toBe(null);
    expect(msg({ action: "openLink", url: "file:///etc/passwd" })).toBe(null);
    expect(msg({ action: "openLink", url: "/relative" })).toBe(null);
  });
});

describe("safeWebUrl", () => {
  test("accepts http and https only", () => {
    expect(safeWebUrl("http://a.test/")).toBe("http://a.test/");
    expect(safeWebUrl("data:text/html,x")).toBe(null);
    expect(safeWebUrl(123)).toBe(null);
    expect(safeWebUrl(`https://a.test/${"x".repeat(MAX_LINK_LENGTH)}`)).toBe(null);
  });
});

describe("block state", () => {
  test("round-trips per key", () => {
    const storage = memoryStorage();
    const key = blockStateKey("msg-1", 42);
    expect(loadBlockState(key, storage)).toBe(undefined);
    saveBlockState(key, { $guests: 6 }, storage);
    expect(loadBlockState(key, storage)).toEqual({ $guests: 6 });
    expect(loadBlockState(blockStateKey("msg-1", 7), storage)).toBe(undefined);
  });

  test("evicts the oldest entries beyond the cap", () => {
    const storage = memoryStorage();
    for (let i = 0; i <= MAX_ENTRIES; i++) saveBlockState(`k${i}`, { i }, storage);
    expect(loadBlockState("k0", storage)).toBe(undefined);
    expect(loadBlockState(`k${MAX_ENTRIES}`, storage)).toEqual({ i: MAX_ENTRIES });
  });

  test("ignores corrupt entries", () => {
    const storage = memoryStorage();
    storage.setItem("openhorn.genUi.state:bad", "{not json");
    expect(loadBlockState("bad", storage)).toBe(undefined);
  });
});

describe("genUi store", () => {
  test("persists the toggle", () => {
    const storage = memoryStorage();
    const store = createGenUiStore(storage);
    expect(store.getState().enabled).toBe(false);
    store.getState().toggle();
    expect(store.getState().enabled).toBe(true);
    expect(storage.getItem(GEN_UI_STORAGE_KEY)).toBe("true");
    expect(createGenUiStore(storage).getState().enabled).toBe(true);
  });

  test("composer requests carry a fresh nonce and clear only their own", () => {
    const store = createGenUiStore(memoryStorage());
    store.getState().requestComposerText("  next step  ");
    const first = store.getState().composerRequest;
    expect(first?.text).toBe("next step");
    store.getState().requestComposerText("next step");
    const second = store.getState().composerRequest;
    expect(second?.nonce === first?.nonce).toBe(false);
    store.getState().clearComposerRequest(first?.nonce ?? -1);
    expect(store.getState().composerRequest?.nonce).toBe(second?.nonce);
    store.getState().requestComposerText("   ");
    expect(store.getState().composerRequest?.nonce).toBe(second?.nonce);
  });

  test("composer requests are capped for every source", () => {
    const store = createGenUiStore(memoryStorage());
    store.getState().requestComposerText("y".repeat(MAX_PROMPT_LENGTH + 500));
    expect(store.getState().composerRequest?.text.length).toBe(MAX_PROMPT_LENGTH);
  });
});

describe("functions", () => {
  test("list helpers", () => {
    expect(Toggle.fn({ list: ["a", "b"], item: "a" })).toEqual(["b"]);
    expect(Toggle.fn({ list: ["a"], item: "b" })).toEqual(["a", "b"]);
    expect(Includes.fn({ list: [1, 2], item: "2" })).toBe(true);
    expect(Range.fn({ start: 0, end: 3 })).toEqual([0, 1, 2]);
  });

  test("payment matches the annuity formula and handles zero interest", () => {
    expect(Math.round(Payment.fn({ principal: 100000, annualRatePercent: 6, periods: 12 }))).toBe(
      8607,
    );
    expect(Payment.fn({ principal: 1200, annualRatePercent: 0, periods: 12 })).toBe(100);
  });

  test("format", () => {
    expect(Format.fn({ value: 1234.5, kind: "number" })).toBe("1,234.5");
    expect(Format.fn({ value: 45, kind: "percent" })).toBe("45%");
    expect(Format.fn({ value: 12, kind: "currency" }).includes("12.00")).toBe(true);
  });
});
