import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __clearDuckDuckGoCache } from "shared/search";
import { canonicalizeWorkspaceRoot } from "../workspace";
import { executeTool, runWebSearch } from "./direct";

const noSleep = async () => {};

const DDG_LITE_HTML = `<table>
<tr><td><a rel="nofollow" href="https://example.com/news" class='result-link'>AI News Today</a></td></tr>
<tr><td class='result-snippet'>Latest updates from the AI world.</td></tr>
</table>`;

test("runWebSearch falls back to DuckDuckGo when no tavily key exists", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("最近 AI 圈有什么新闻 (sidecar-ddg-1)", {
    sleep: noSleep,
    fetchImpl: async (input) => {
      expect(String(input).includes("duckduckgo.com")).toBe(true);
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.includes("https://example.com/news")).toBe(true);
  expect(result.includes("AI News Today")).toBe(true);
});

test("runWebSearch uses Tavily when a key is configured", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("推送今天科技新闻 (sidecar-tavily-1)", {
    tavilyApiKey: "test-key",
    sleep: noSleep,
    fetchImpl: async (input, init) => {
      expect(String(input).includes("api.tavily.com")).toBe(true);
      const body = JSON.parse(String(init?.body ?? "{}")) as { api_key?: string; topic?: string };
      expect(body.api_key).toBe("test-key");
      expect(body.topic).toBe("news");
      return new Response(
        JSON.stringify({
          answer: "Here is a summary.",
          results: [{ title: "Tech News", url: "https://ithome.com/0/1", content: "details" }],
        }),
      );
    },
  });

  expect(result.includes("Here is a summary.")).toBe(true);
  expect(result.includes("https://ithome.com/0/1")).toBe(true);
});

test("runWebSearch degrades to DuckDuckGo when Tavily upstream fails", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("最近科技新闻 (sidecar-degrade-1)", {
    tavilyApiKey: "test-key",
    sleep: noSleep,
    fetchImpl: async (input) => {
      if (String(input).includes("api.tavily.com")) {
        return new Response("upstream down", { status: 500 });
      }
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.includes("https://example.com/news")).toBe(true);
});

test("runWebSearch returns an error for an empty query", async () => {
  const result = await runWebSearch("   ");
  expect(result).toBe("Error: query is required");
});

/**
 * Regression tests for the direct-runtime fs tool workspace boundary.
 * Before the fix these tools did a bare `path.resolve(cwd, path)` with no
 * boundary check, so `/etc/passwd` or `../../` escaped the workspace.
 */
describe("direct fs tools workspace boundary", () => {
  async function makeWorkspace(): Promise<string> {
    return canonicalizeWorkspaceRoot(mkdtempSync(path.join(os.tmpdir(), "openhorn-direct-")));
  }

  test("read_file rejects absolute path outside workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("read_file", { path: "/etc/passwd" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("read_file rejects .. traversal escape", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("read_file", { path: "../../../etc/passwd" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("read_file reads a file inside the workspace", async () => {
    const cwd = await makeWorkspace();
    writeFileSync(path.join(cwd, "hello.txt"), "hi there");
    const result = await executeTool("read_file", { path: "hello.txt" }, cwd);
    expect(result).toBe("hi there");
  });

  test("read_file accepts an absolute path that lives inside the workspace", async () => {
    const cwd = await makeWorkspace();
    writeFileSync(path.join(cwd, "abs.txt"), "absolute-ok");
    const result = await executeTool("read_file", { path: path.join(cwd, "abs.txt") }, cwd);
    expect(result).toBe("absolute-ok");
  });

  test("write_file rejects escaping the workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("write_file", { path: "../escape.txt", content: "nope" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("write_file writes inside the workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool(
      "write_file",
      { path: "nested/out.txt", content: "written" },
      cwd,
    );
    expect(result.startsWith("File written:")).toBe(true);
    expect(readFileSync(path.join(cwd, "nested/out.txt"), "utf-8")).toBe("written");
  });

  test("list_dir rejects escaping the workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("list_dir", { path: "../.." }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });
});
