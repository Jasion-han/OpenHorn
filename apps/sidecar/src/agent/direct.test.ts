import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __clearDuckDuckGoCache } from "shared/search";
import { canonicalizeWorkspaceRoot } from "../workspace";
import { buildModel, executeTool, isBlockedIpAddress, runWebSearch } from "./direct";

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

  test("grep rejects an absolute path outside the workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("grep", { pattern: "root", path: "/etc" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("grep rejects a .. traversal escape", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("grep", { pattern: "root", path: "../.." }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("grep searches files inside the workspace", async () => {
    const cwd = await makeWorkspace();
    writeFileSync(path.join(cwd, "note.txt"), "the needle is here");
    const result = await executeTool("grep", { pattern: "needle", path: "." }, cwd);
    expect(result.includes("needle")).toBe(true);
  });

  test("glob rejects an absolute base outside the workspace", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("glob", { pattern: "/etc/*.conf" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("glob rejects a .. traversal base", async () => {
    const cwd = await makeWorkspace();
    const result = await executeTool("glob", { pattern: "../*.ts" }, cwd);
    expect(result.startsWith("Error:")).toBe(true);
  });

  test("glob finds files inside the workspace", async () => {
    const cwd = await makeWorkspace();
    writeFileSync(path.join(cwd, "foo.ts"), "export const x = 1;");
    const result = await executeTool("glob", { pattern: "*.ts" }, cwd);
    expect(result.includes("foo.ts")).toBe(true);
  });
});

/**
 * Pure SSRF address classifier for web_fetch — must block loopback, private,
 * link-local (incl. cloud-metadata), and unique-local/link-local IPv6, while
 * allowing genuine public addresses and bare hostnames (resolved separately).
 */
describe("web_fetch SSRF address classifier", () => {
  test("blocks loopback, private, and link-local IPv4", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.5")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("172.16.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("0.0.0.0")).toBe(true);
  });

  test("blocks loopback and unique-local/link-local IPv6", () => {
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
    expect(isBlockedIpAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:169.254.169.254")).toBe(true);
  });

  test("allows public addresses and bare hostnames", () => {
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
    expect(isBlockedIpAddress("1.1.1.1")).toBe(false);
    expect(isBlockedIpAddress("172.32.0.1")).toBe(false);
    expect(isBlockedIpAddress("example.com")).toBe(false);
    expect(isBlockedIpAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

// A google channel used to be driven as openai-completions because protocol
// never reached buildModel — and the schema rejected "google" outright, so the
// run failed before that even mattered. Both ends are now wired.
describe("buildModel protocol routing", () => {
  const base = {
    apiKey: "k",
    model: "m",
    prompt: "p",
    cwd: "/tmp",
    abortController: new AbortController(),
    requestApproval: async () => true,
    onEvent: () => {},
  };

  test("google protocol selects the Gemini generative-language API", () => {
    const model = buildModel({ ...base, protocol: "google" }, false);
    expect(model.api).toBe("google-generative-ai");
    expect(model.provider).toBe("google");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  test("google protocol honours a custom baseUrl and strips the trailing slash", () => {
    const model = buildModel(
      { ...base, protocol: "google", baseUrl: "https://relay.test/v1/" },
      false,
    );
    expect(model.baseUrl).toBe("https://relay.test/v1");
  });

  test("openai protocol still selects openai-completions", () => {
    const model = buildModel({ ...base, protocol: "openai" }, false);
    expect(model.api).toBe("openai-completions");
  });

  test("an absent protocol defaults to openai-completions", () => {
    const model = buildModel({ ...base }, false);
    expect(model.api).toBe("openai-completions");
  });
});

// The system prompt tells the model to read each skill's SKILL.md by ABSOLUTE
// path, but those folders live outside the workspace. Without readAllowRoots
// every such read was rejected, so Agent Skills silently did nothing on the
// direct (OpenAI/generic) runtime.
describe("read_file skill allow-roots", () => {
  test("reads a SKILL.md that lives outside the workspace when its folder is allowed", async () => {
    const cwd = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    const skillDir = mkdtempSync(path.join(os.tmpdir(), "openhorn-skill-"));
    const skillMd = path.join(skillDir, "SKILL.md");
    writeFileSync(skillMd, "# Test Skill", "utf8");

    const allowed = await executeTool("read_file", { path: skillMd }, cwd, {
      readAllowRoots: [skillDir],
    });
    expect(allowed).toBe("# Test Skill");
  });

  test("still rejects the same path when no skill folder is allowed", async () => {
    const cwd = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    const skillDir = mkdtempSync(path.join(os.tmpdir(), "openhorn-skill-"));
    const skillMd = path.join(skillDir, "SKILL.md");
    writeFileSync(skillMd, "# Test Skill", "utf8");

    const rejected = await executeTool("read_file", { path: skillMd }, cwd, {});
    expect(rejected.startsWith("Error:")).toBe(true);
  });

  test("an allowed skill folder does not open up unrelated paths", async () => {
    const cwd = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    const skillDir = mkdtempSync(path.join(os.tmpdir(), "openhorn-skill-"));

    const rejected = await executeTool("read_file", { path: "/etc/passwd" }, cwd, {
      readAllowRoots: [skillDir],
    });
    expect(rejected.startsWith("Error:")).toBe(true);
  });
});
