import { expect, test } from "bun:test";
import type { GenericAgentTurnResult, ToolCallingAdapter, ToolCallingOptions } from "adapters";
import type { RunDirectAgentInput } from "./direct";
import type { AgentEvent } from "./events";
import { researchEvidence, runResearchAgent, validResearchReportSources } from "./research";

const source = "https://example.com/evidence";
const searchResult = `Sources\n${JSON.stringify([{ url: source, title: "Evidence", snippet: "A fact" }])}`;
const pageResult = `Page\n${JSON.stringify([{ url: source, content: "Actual original evidence" }])}`;
const call = (
  name: string,
  input: Record<string, unknown>,
  id = crypto.randomUUID(),
): GenericAgentTurnResult => ({ text: "", toolCalls: [{ name, input, id }] });
function fixture(turns: GenericAgentTurnResult[], overrides: Partial<RunDirectAgentInput> = {}) {
  const events: AgentEvent[] = [],
    requests: ToolCallingOptions[] = [],
    executions: string[] = [];
  const input: RunDirectAgentInput = {
    cwd: "/tmp/research-fixture",
    apiKey: "synthetic-answer-key",
    model: "gpt-4o",
    protocol: "openai",
    prompt: "Compare evidence",
    webSearchEnabled: true,
    searchProvider: "tavily",
    tavilyApiKey: "synthetic-search-key",
    abortController: new AbortController(),
    onEvent: (event) => events.push(event),
    ...overrides,
  };
  const adapter = {
    async runToolCallingTurn(options: ToolCallingOptions) {
      requests.push(structuredClone({ ...options, signal: undefined }));
      if (!options.tools.length) return { text: `Report [Evidence](${source})`, toolCalls: [] };
      return turns.shift() ?? { text: "Enough evidence", toolCalls: [] };
    },
  } as ToolCallingAdapter;
  const execute = async (
    name: string,
    _value: Record<string, unknown>,
    _cwd: string,
    options?: Parameters<typeof import("./direct").executeTool>[3],
  ) => {
    executions.push(name);
    options?.onSearchSource?.({ provider: "tavily" });
    return name === "web_search" ? searchResult : pageResult;
  };
  return { input, events, requests, executions, adapter, execute };
}

test("research executes only selected search/read tools, preserves provenance and writes a separate evidence report", async () => {
  const f = fixture([
    call("web_search", { query: "first evidence" }),
    call("web_search", { query: "second perspective" }),
    call("web_fetch", { url: source }),
    { text: "Findings", toolCalls: [] },
  ]);
  await runResearchAgent(f.input, f);
  expect(f.executions).toEqual(["web_search", "web_search", "web_fetch"]);
  expect(f.events.some((event) => event.type === "text" && event.content.includes("Report"))).toBe(
    true,
  );
  expect(f.events.at(-1)?.type).toBe("done");
  expect(
    f.events
      .filter((event) => event.type === "tool_result")
      .every((event) => event.type !== "tool_result" || event.searchSource?.provider === "tavily"),
  ).toBe(true);
  expect(f.requests[0].tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
  expect(f.requests.at(-1)?.tools).toHaveLength(0);
  const context = JSON.stringify(f.requests);
  expect(context.includes("synthetic-search-key")).toBe(false);
  expect(context.includes("synthetic-answer-key")).toBe(false);
  expect(context.includes("Actual original evidence")).toBe(true);
});

for (const [name, override, code] of [
  ["network disabled", { webSearchEnabled: false }, "research_network_required"],
  ["CLI runtime", { protocol: "codex_cli" }, "research_unavailable"],
  ["ACP runtime", { protocol: "acp" }, "research_unavailable"],
  ["CLI OAuth", { apiKey: "eyJsynthetic-only" }, "research_unavailable"],
  ["explicit MCP", { targetMcpServer: "tavily" }, "research_unavailable"],
  [
    "image input",
    { attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "AA==" }] },
    "research_attachments_unsupported",
  ],
] as const)
  test(`research refuses ${name} before any model or tools`, async () => {
    const f = fixture([], override as Partial<RunDirectAgentInput>);
    await runResearchAgent(f.input, f);
    expect(f.requests).toHaveLength(0);
    expect(f.executions).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ type: "error", errorCode: code });
  });

test("research reuses duplicate queries and canonical URLs without extra network calls", async () => {
  const f = fixture([
    call("web_search", { query: "A QUERY" }),
    call("web_search", { query: "a   query" }),
    call("web_fetch", { url: `${source}#one` }),
    call("web_fetch", { url: `${source}#two` }),
    call("web_search", { query: "different" }),
    { text: "done", toolCalls: [] },
  ]);
  await runResearchAgent(f.input, f);
  expect(f.executions).toEqual(["web_search", "web_fetch", "web_search"]);
});

test("failed searches consume the unique request budget and cannot produce a successful report", async () => {
  const f = fixture(
    Array.from({ length: 12 }, (_, i) => call("web_search", { query: `query ${i}` })),
  );
  let calls = 0;
  await runResearchAgent(f.input, {
    ...f,
    execute: async () => {
      calls++;
      return "Search error: provider failed";
    },
  });
  expect(calls).toBe(4);
  expect(f.events.some((event) => event.type === "text")).toBe(false);
  expect(f.events.find((event) => event.type === "error")).toMatchObject({
    type: "error",
    errorCode: "research_no_sources",
  });
});

test("model-requested shell tools are answered as errors and never executed", async () => {
  const f = fixture([
    call("web_search", { query: "evidence" }),
    call("Bash", { command: "curl other-search.invalid" }),
    call("web_search", { query: "verify" }),
    call("web_fetch", { url: source }),
    { text: "done", toolCalls: [] },
  ]);
  await runResearchAgent(f.input, f);
  expect(f.executions.includes("Bash")).toBe(false);
  expect(JSON.stringify(f.requests).includes("unknown or invalid research tool")).toBe(true);
});

test("Stop interrupts an in-flight tool and suppresses late report/result events", async () => {
  const f = fixture([call("web_search", { query: "evidence" })]);
  let release: (value: string) => void = () => {};
  const held = new Promise<string>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = runResearchAgent(f.input, {
    ...f,
    execute: async () => {
      entered();
      return held;
    },
  });
  await ready;
  f.input.abortController.abort();
  await running;
  release(searchResult);
  await Promise.resolve();
  expect(
    f.events.some(
      (event) => event.type === "text" || event.type === "tool_result" || event.type === "error",
    ),
  ).toBe(false);
});

test("a pre-stopped research makes no calls", async () => {
  const f = fixture([]);
  f.input.abortController.abort();
  await runResearchAgent(f.input, f);
  expect(f.requests).toHaveLength(0);
  expect(f.events).toEqual([{ type: "done" }]);
});

test("only structured public sources count as evidence; summary URLs and title shells do not", () => {
  expect(researchEvidence(`The model says see ${source}`, "search")).toHaveLength(0);
  expect(
    researchEvidence(JSON.stringify([{ url: "http://127.0.0.1/secret", content: "x" }]), "page"),
  ).toHaveLength(0);
  expect(researchEvidence(JSON.stringify([{ url: source, title: "Shell" }]), "page")).toHaveLength(
    0,
  );
  expect(researchEvidence(pageResult, "page")).toEqual([{ url: source, kind: "page" }]);
});

test("a final report cannot add model-invented source links", async () => {
  const f = fixture([
    call("web_search", { query: "evidence" }),
    call("web_search", { query: "verification" }),
    call("web_fetch", { url: source }),
    { text: "done", toolCalls: [] },
  ]);
  const real = f.adapter.runToolCallingTurn;
  f.adapter.runToolCallingTurn = async (options) =>
    options.tools.length
      ? real(options)
      : { text: "Invented source https://never-fetched.invalid/", toolCalls: [] };
  await runResearchAgent(f.input, f);
  expect(f.events.some((event) => event.type === "text")).toBe(false);
  expect(f.events.find((event) => event.type === "error")).toMatchObject({
    type: "error",
    errorCode: "research_failed",
  });
});

test("research caps page tasks independently, including failed page reads", async () => {
  const f = fixture([
    call("web_search", { query: "evidence" }),
    ...Array.from({ length: 11 }, (_, i) =>
      call("web_fetch", { url: `https://example.com/page-${i}` }),
    ),
  ]);
  let pages = 0;
  await runResearchAgent(f.input, {
    ...f,
    execute: async (name) => {
      if (name === "web_search") return searchResult;
      pages++;
      return "Fetch error: unavailable";
    },
  });
  expect(pages).toBe(6);
  expect(f.events.some((event) => event.type === "text")).toBe(true);
  expect(f.requests.at(-1)?.messages.at(-1)?.content.includes('"kind":"search"')).toBe(true);
  expect(f.requests.at(-1)?.messages.at(-1)?.content.includes('"kind":"page"')).toBe(false);
});

test("report synthesis remains inside the same cancellation signal and no-retry policy", async () => {
  const f = fixture([
    call("web_search", { query: "evidence" }),
    call("web_search", { query: "verify" }),
    call("web_fetch", { url: source }),
    { text: "done", toolCalls: [] },
  ]);
  const real = f.adapter.runToolCallingTurn;
  let entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.adapter.runToolCallingTurn = async (options) => {
    expect(options.noRetry).toBe(true);
    if (options.tools.length) return real(options);
    entered();
    return new Promise(() => {});
  };
  const pending = runResearchAgent(f.input, f);
  await ready;
  f.input.abortController.abort();
  await pending;
  expect(f.events.some((event) => event.type === "text" || event.type === "error")).toBe(false);
  expect(f.events.filter((event) => event.type === "done")).toHaveLength(1);
});

test("research decisions and final report respect a channel's smaller output limit", async () => {
  const f = fixture(
    [
      call("web_search", { query: "evidence" }),
      call("web_search", { query: "verify" }),
      call("web_fetch", { url: source }),
      { text: "done", toolCalls: [] },
    ],
    {
      contextMetadata: {
        contextWindow: 8192,
        maxOutputTokens: 1024,
        source: "channel",
        fetchedAt: 0,
      },
    },
  );
  await runResearchAgent(f.input, f);
  expect(f.requests.length > 1).toBe(true);
  expect(f.requests.every((request) => request.maxTokens === 1024)).toBe(true);
  expect(f.events.at(-1)?.type).toBe("done");
});

test("valid source URLs with Markdown parentheses and escapes remain valid, while added URLs fail", () => {
  const url = "https://example.com/source_(2026)";
  expect(validResearchReportSources(`[source](<${url}>)`, [url])).toBe(true);
  expect(validResearchReportSources(`[source](${url})`, [url])).toBe(true);
  expect(validResearchReportSources(`Source: ${url}.`, [url])).toBe(true);
  expect(validResearchReportSources("[source](https://example.com/source_\\(2026\\))", [url])).toBe(
    true,
  );
  expect(validResearchReportSources(`[source](${url}) https://other.invalid`, [url])).toBe(false);
});

test("all early research failures emit one terminal transport event after the error", async () => {
  const f = fixture([], { webSearchEnabled: false });
  await runResearchAgent(f.input, f);
  expect(f.events.map((event) => event.type)).toEqual(["error", "done"]);
});

test("an elapsed total deadline cannot start a late report even before the timer callback fires", async () => {
  const f = fixture([call("web_search", { query: "evidence" })]);
  let clock = 0;
  await runResearchAgent(f.input, {
    ...f,
    now: () => clock,
    execute: async () => {
      clock = 181_000;
      return searchResult;
    },
  });
  expect(f.requests).toHaveLength(1);
  expect(f.events.find((event) => event.type === "error")).toMatchObject({
    errorCode: "research_timeout",
  });
  expect(f.events.at(-1)?.type).toBe("done");
});

test("tool work reserves the final report window inside the same total deadline", async () => {
  const f = fixture([
    call("web_search", { query: "first" }),
    call("web_search", { query: "second" }),
    call("web_fetch", { url: source }),
  ]);
  let clock = 0,
    executed = 0;
  await runResearchAgent(f.input, {
    ...f,
    now: () => clock,
    execute: async () => {
      if (++executed === 2) clock = 151_000;
      return searchResult;
    },
  });
  expect(executed).toBe(2);
  expect(f.requests).toHaveLength(3);
  expect(f.requests.at(-1)?.tools).toHaveLength(0);
  expect((f.requests.at(-1)?.requestTimeoutMs ?? 0) <= 29_000).toBe(true);
  expect(f.events.at(-1)?.type).toBe("done");
});
