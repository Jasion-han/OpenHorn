import { describe, expect, test } from "bun:test";
import {
  findKnownSlashToken,
  findSlashTokenAtCursor,
  type SlashCommandType,
  stripSlashToken,
} from "./slashToken";

const known = new Map<string, SlashCommandType>([
  ["web-access", "skill"],
  ["context7", "mcp"],
  ["新会话", "command"],
]);

function mustFind(text: string) {
  const token = findKnownSlashToken(text, known);
  if (!token) throw new Error(`expected a known token in: ${text}`);
  return token;
}

describe("findKnownSlashToken", () => {
  test("matches a leading token", () => {
    expect(findKnownSlashToken("/web-access hi", known)).toEqual({
      start: 0,
      end: 11,
      name: "web-access",
      type: "skill",
    });
  });

  test("matches a mid-text token after whitespace", () => {
    expect(findKnownSlashToken("查一下 /context7 react 文档", known)).toEqual({
      start: 4,
      end: 13,
      name: "context7",
      type: "mcp",
    });
  });

  test("matches after a newline", () => {
    const token = findKnownSlashToken("第一行\n/web-access 继续", known);
    expect(token?.start).toBe(4);
    expect(token?.type).toBe("skill");
  });

  test("preserves original casing in name", () => {
    expect(findKnownSlashToken("/Context7 hi", known)?.name).toBe("Context7");
  });

  test("ignores slash not at a token boundary", () => {
    expect(findKnownSlashToken("a/web-access", known)).toEqual(null);
    expect(findKnownSlashToken("https://x.com/context7", known)).toEqual(null);
  });

  test("ignores unknown tokens", () => {
    expect(findKnownSlashToken("/unknown hi", known)).toEqual(null);
  });

  test("returns only the first known token", () => {
    expect(findKnownSlashToken("/web-access 再 /context7", known)?.name).toBe("web-access");
  });
});

describe("findSlashTokenAtCursor", () => {
  test("triggers at start of empty-prefix input", () => {
    expect(findSlashTokenAtCursor("/we", 3)).toEqual({ start: 0, query: "we" });
  });

  test("triggers when / typed at the start of existing text", () => {
    expect(findSlashTokenAtCursor("/帮我搜一下新闻", 1)).toEqual({ start: 0, query: "" });
  });

  test("triggers mid-text after whitespace", () => {
    expect(findSlashTokenAtCursor("帮我 /web 搜索", 7)).toEqual({ start: 3, query: "web" });
  });

  test("does not trigger inside a path or URL", () => {
    expect(findSlashTokenAtCursor("a/b", 3)).toEqual(null);
    expect(findSlashTokenAtCursor("https://x", 9)).toEqual(null);
    expect(findSlashTokenAtCursor("/usr/bin", 8)).toEqual(null);
  });

  test("does not trigger when cursor left the token", () => {
    expect(findSlashTokenAtCursor("/web 后面", 7)).toEqual(null);
  });

  test("does not trigger right after CJK text without whitespace", () => {
    expect(findSlashTokenAtCursor("帮我搜新闻/web", 9)).toEqual(null);
  });

  test("does not trigger on a double slash", () => {
    expect(findSlashTokenAtCursor("//", 2)).toEqual(null);
  });

  test("triggers after a newline", () => {
    expect(findSlashTokenAtCursor("第一行\n/we", 7)).toEqual({ start: 4, query: "we" });
  });
});

describe("stripSlashToken", () => {
  test("removes a leading token and its trailing space", () => {
    const text = "/context7 帮我搜一下新闻";
    expect(stripSlashToken(text, mustFind(text))).toBe("帮我搜一下新闻");
  });

  test("removes a mid-text token keeping surrounding text", () => {
    const text = "帮我 /web-access 搜一下新闻";
    expect(stripSlashToken(text, mustFind(text))).toBe("帮我 搜一下新闻");
  });

  test("token-only text strips to empty", () => {
    expect(stripSlashToken("/web-access", mustFind("/web-access"))).toBe("");
  });
});
