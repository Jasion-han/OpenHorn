import { describe, expect, test } from "bun:test";
import type { ImportPart, LocalImportScanResult } from "shared/types";
import type { CredentialSource } from "../lib/credentialApi";
import type { ServerApi } from "../lib/serverApi";
import type { DiscoveredMcpServer, DiscoveredSkill } from "../lib/tauriBridge";
import type { ApiImportRecord } from "../types/chat";
import {
  aggregateScan,
  chunkSessionIds,
  collectNeedsAction,
  createImportStore,
  importSourceFromClientLabel,
  mergeParts,
  summaryNewCount,
} from "./importStore";

function mcp(
  name: string,
  clients: string[],
  overrides: Partial<DiscoveredMcpServer> = {},
): DiscoveredMcpServer {
  return {
    client: clients[0] ?? "",
    clients,
    name,
    type: "stdio",
    config: { command: name },
    signature: `sig:${name}`,
    ...overrides,
  };
}

function skill(name: string, clients: string[]): DiscoveredSkill {
  return { name, path: `/skills/${name}`, client: clients[0] ?? "", clients };
}

const serverScan: LocalImportScanResult = {
  homeDir: "/Users/x",
  sources: [
    {
      source: "claude-code",
      available: true,
      parts: {
        conversations: { count: 12, handledBy: "server" },
        instructions: { count: 1, handledBy: "server", path: "/Users/x/.claude/CLAUDE.md" },
        prompts: { count: 0, handledBy: "server" },
        mcp: { handledBy: "desktop" },
        skills: { handledBy: "desktop" },
      },
    },
    {
      source: "codex",
      available: true,
      parts: { conversations: { count: 3, handledBy: "server" } },
    },
    { source: "gemini", available: false, parts: {} },
    { source: "cursor", available: false, parts: {} },
  ],
};

describe("importSourceFromClientLabel", () => {
  test("maps every Rust/server client label onto a shared ImportSource", () => {
    expect(importSourceFromClientLabel("Claude Code")).toBe("claude-code");
    expect(importSourceFromClientLabel("Codex CLI")).toBe("codex");
    expect(importSourceFromClientLabel("Gemini CLI")).toBe("gemini");
    expect(importSourceFromClientLabel("CC-Switch")).toBe("cc-switch");
    expect(importSourceFromClientLabel("OpenCode")).toBe("opencode");
    expect(importSourceFromClientLabel("Cursor")).toBe("cursor");
    expect(importSourceFromClientLabel("Claude Desktop")).toBe("claude-desktop");
    expect(importSourceFromClientLabel("Continue")).toBe("continue");
    expect(importSourceFromClientLabel("VS Code")).toBe("vscode");
  });

  test("unknown labels (picked file) return null", () => {
    expect(importSourceFromClientLabel("导入的文件")).toBe(null);
  });
});

describe("aggregateScan", () => {
  test("folds server parts and desktop discovery into one row per source, in display order", () => {
    const rows = aggregateScan({
      server: serverScan,
      mcp: [
        mcp("playwright", ["CC-Switch", "Claude Code", "Codex CLI"]),
        mcp("github", ["Cursor"]),
        mcp("vscode-only", ["VS Code"]),
        mcp("picked-only", ["导入的文件"]),
      ],
      skills: [skill("pdf", ["Claude Code", "Gemini CLI"]), skill("csv", ["Continue"])],
      disabledSkills: new Set(["csv"]),
      credentials: [
        {
          id: "cli-codex",
          provider: "openai",
          sourceType: "cli_oauth",
          sourceName: "Codex CLI",
          status: "available",
        },
        {
          id: "env-openai-api-key",
          provider: "openai",
          sourceType: "env_var",
          sourceName: "OPENAI_API_KEY",
          status: "available",
        },
      ],
      existingMcpNames: new Set(["github"]),
      existingChannelNames: new Set(),
    });

    expect(rows.map((row) => row.source)).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "cc-switch",
      "cursor",
      "vscode",
      "continue",
      "file",
    ]);

    const claude = rows[0];
    expect(claude.available).toBe(true);
    expect(claude.conversations).toEqual({ count: 12 });
    expect(claude.instructions).toEqual({ count: 1, path: "/Users/x/.claude/CLAUDE.md" });
    expect(claude.prompts).toEqual({ count: 0 });
    // playwright is owned by CC-Switch (`client`), so it is not listed here.
    expect(claude.mcp).toBe(undefined);
    expect(claude.skills?.entries.map((e) => e.name)).toEqual(["pdf"]);
    expect(claude.skills?.newCount).toBe(0);

    const codex = rows[1];
    expect(codex.credentials?.entries.map((e) => e.id)).toEqual(["cli-codex"]);
    expect(codex.credentials?.newCount).toBe(1);
    expect(codex.mcp).toBe(undefined);

    // Gemini only appears in pdf's `clients`, not as owner → nothing discovered,
    // and the server scan marks it unavailable.
    const gemini = rows[2];
    expect(gemini.available).toBe(false);
    expect(gemini.skills).toBe(undefined);

    const ccSwitch = rows[3];
    expect(ccSwitch.available).toBe(true);
    expect(ccSwitch.mcp?.entries.map((e) => e.name)).toEqual(["playwright"]);
    expect(ccSwitch.mcp?.newCount).toBe(1);
    expect(ccSwitch.mcp?.entries[0]?.clients).toEqual(["CC-Switch", "Claude Code", "Codex CLI"]);

    const cursor = rows[4];
    expect(cursor.mcp?.entries[0]?.exists).toBe(true);
    expect(cursor.mcp?.newCount).toBe(0);

    const vscode = rows[5];
    expect(vscode.available).toBe(true);
    expect(vscode.mcp?.entries.map((e) => e.name)).toEqual(["vscode-only"]);

    const cont = rows[6];
    expect(cont.skills?.newCount).toBe(1);

    // Unmapped clients + env keys land in the catch-all row.
    const file = rows[7];
    expect(file.available).toBe(true);
    expect(file.mcp?.entries.map((e) => e.name)).toEqual(["picked-only"]);
    expect(file.credentials?.entries[0]?.importable).toBe(false);
    expect(file.credentials?.newCount).toBe(0);
  });

  test("a skill symlinked into several clients is listed only under its owner (`client`)", () => {
    const rows = aggregateScan({
      server: null,
      mcp: [],
      skills: [
        {
          name: "pdf",
          path: "/cc-switch/skills/pdf",
          client: "CC-Switch",
          clients: ["CC-Switch", "Claude Code", "Continue"],
        },
        skill("csv", ["Claude Code"]),
      ],
      disabledSkills: new Set(),
      credentials: [],
      existingMcpNames: new Set(),
      existingChannelNames: new Set(),
    });
    expect(rows.map((row) => row.source)).toEqual(["claude-code", "cc-switch"]);
    const ccSwitch = rows.find((row) => row.source === "cc-switch");
    expect(ccSwitch?.skills?.entries.map((e) => e.name)).toEqual(["pdf"]);
    // `clients` is kept for the "also present in …" detail.
    expect(ccSwitch?.skills?.entries[0]?.clients).toEqual(["CC-Switch", "Claude Code", "Continue"]);
    const claude = rows.find((row) => row.source === "claude-code");
    expect(claude?.skills?.entries.map((e) => e.name)).toEqual(["csv"]);
    expect(rows.some((row) => row.source === "continue")).toBe(false);
  });

  test("an MCP server symlinked into several clients is listed only under its owner (`client`)", () => {
    const rows = aggregateScan({
      server: null,
      mcp: [
        mcp("playwright", ["CC-Switch", "Claude Code", "Codex CLI"]),
        mcp("github", ["Claude Code"]),
      ],
      skills: [],
      disabledSkills: new Set(),
      credentials: [],
      existingMcpNames: new Set(),
      existingChannelNames: new Set(),
    });
    expect(rows.map((row) => row.source)).toEqual(["claude-code", "cc-switch"]);
    const ccSwitch = rows.find((row) => row.source === "cc-switch");
    expect(ccSwitch?.mcp?.entries.map((e) => e.name)).toEqual(["playwright"]);
    expect(ccSwitch?.mcp?.newCount).toBe(1);
    const claude = rows.find((row) => row.source === "claude-code");
    expect(claude?.mcp?.entries.map((e) => e.name)).toEqual(["github"]);
    expect(rows.some((row) => row.source === "codex")).toBe(false);
  });

  test("entries whose owner label is unknown (picked file) land in the `file` row", () => {
    const rows = aggregateScan({
      server: null,
      mcp: [mcp("picked", ["导入的文件", "Claude Code"])],
      skills: [skill("loose", ["Unknown Client"])],
      disabledSkills: new Set(),
      credentials: [],
      existingMcpNames: new Set(),
      existingChannelNames: new Set(),
    });
    expect(rows.map((row) => row.source)).toEqual(["file"]);
    expect(rows[0].available).toBe(true);
    expect(rows[0].mcp?.entries.map((e) => e.name)).toEqual(["picked"]);
    expect(rows[0].skills?.entries.map((e) => e.name)).toEqual(["loose"]);
  });

  test("sources with nothing to import stay unavailable and are omitted when never scanned", () => {
    const rows = aggregateScan({
      server: serverScan,
      mcp: [],
      skills: [],
      disabledSkills: new Set(),
      credentials: [],
      existingMcpNames: new Set(),
      existingChannelNames: new Set(),
    });
    expect(rows.map((row) => row.source)).toEqual(["claude-code", "codex", "gemini", "cursor"]);
    expect(rows[2].available).toBe(false);
    expect(rows.some((row) => row.source === "file")).toBe(false);
  });

  test("summaryNewCount counts only not-yet-imported things", () => {
    const [claude] = aggregateScan({
      server: serverScan,
      mcp: [mcp("a", ["Claude Code"]), mcp("b", ["Claude Code"])],
      skills: [skill("s1", ["Claude Code"]), skill("s2", ["Claude Code"])],
      disabledSkills: new Set(["s2"]),
      credentials: [
        {
          id: "cli-claude-code",
          provider: "anthropic",
          sourceType: "cli_oauth",
          sourceName: "Claude Code",
          status: "available",
        },
      ],
      existingMcpNames: new Set(["a"]),
      existingChannelNames: new Set(["Claude Code"]),
    });
    // 12 conversations + 1 instructions + 0 prompts + 1 new mcp + 1 disabled skill + 0 creds
    expect(summaryNewCount(claude)).toBe(15);
  });
});

describe("run helpers", () => {
  test("chunkSessionIds splits at the server cap", () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `s${i}`);
    const chunks = chunkSessionIds(ids);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(201);
    expect(chunkSessionIds([])).toEqual([]);
    expect(chunkSessionIds(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });

  test("mergeParts sums counts per type and caps concatenated items", () => {
    const part = (imported: number, items: number): ImportPart => ({
      type: "conversations",
      imported,
      skipped: 0,
      needsAction: 0,
      items: Array.from({ length: items }, (_, i) => ({ label: `c${i}`, status: "imported" })),
    });
    const merged = mergeParts([
      [part(150, 150), { type: "prompts", imported: 2, skipped: 1, needsAction: 0, items: [] }],
      [part(100, 100)],
    ]);
    expect(merged).toHaveLength(2);
    const conv = merged.find((p) => p.type === "conversations");
    expect(conv?.imported).toBe(250);
    expect(conv?.items).toHaveLength(200);
    expect(merged.find((p) => p.type === "prompts")?.skipped).toBe(1);
  });
});

describe("collectNeedsAction", () => {
  const record = (id: string, statuses: Array<"imported" | "needsAction">): ApiImportRecord => ({
    id,
    userId: "u",
    source: "codex",
    kind: "local",
    parts: [
      {
        type: "credentials",
        imported: 0,
        skipped: 0,
        needsAction: 0,
        items: statuses.map((status, i) => ({ label: `${id}-${i}`, status })),
      },
    ],
    errors: [],
    totalImported: 0,
    totalNeedsAction: 0,
    createdAt: "2026-09-11T00:00:00.000Z",
  });

  test("returns only needsAction items, tagged with their record and part", () => {
    const out = collectNeedsAction([
      record("r1", ["imported", "needsAction"]),
      record("r2", ["needsAction", "needsAction"]),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ recordId: "r1", source: "codex", partType: "credentials" });
    expect(out[0].item.label).toBe("r1-1");
  });

  test("looks at the most recent `limit` records only", () => {
    const records = Array.from({ length: 25 }, (_, i) => record(`r${i}`, ["needsAction"]));
    expect(collectNeedsAction(records)).toHaveLength(20);
    expect(collectNeedsAction(records, 5)).toHaveLength(5);
  });
});

describe("createImportStore.runImport", () => {
  function makeDeps() {
    const calls: {
      runs: Array<{ source: string; parts: Record<string, unknown> }>;
      created: Array<{ name: string; importedFrom?: string }>;
      records: Array<{ source: string; parts: ImportPart[] }>;
      enabled: string[];
      channels: string[];
      conversationsReloaded: number;
    } = { runs: [], created: [], records: [], enabled: [], channels: [], conversationsReloaded: 0 };
    let recordSeq = 0;
    const api = {
      localImport: {
        scan: async () => serverScan,
        listConversations: async () => ({ source: "claude-code", conversations: [] }),
        run: async (data: { source: string; parts: Record<string, unknown> }) => {
          calls.runs.push(data);
          const ids =
            (data.parts.conversations as { sessionIds: string[] } | undefined)?.sessionIds ?? [];
          const parts: ImportPart[] = [];
          if (ids.length) {
            parts.push({
              type: "conversations",
              imported: ids.length,
              skipped: 0,
              needsAction: 0,
              items: ids.map((id) => ({
                label: id,
                status: "imported" as const,
                link: { kind: "conversation" as const, id },
              })),
            });
          }
          if (data.parts.instructions) {
            parts.push({
              type: "instructions",
              imported: 1,
              skipped: 0,
              needsAction: 0,
              items: [],
            });
          }
          recordSeq += 1;
          return { recordId: `rec${recordSeq}`, parts, errors: [] };
        },
      },
      mcp: {
        listServers: async () => ({ servers: [{ name: "github" }] }),
        createServer: async (data: { name: string; importedFrom?: string }) => {
          calls.created.push(data);
          return { server: { id: `mcp-${data.name}`, name: data.name } };
        },
      },
      channels: {
        list: async () => ({ channels: [] }),
        create: async (data: { name: string }) => {
          calls.channels.push(data.name);
          return { channel: { id: `ch-${data.name}` } };
        },
      },
      importRecords: {
        list: async () => ({ records: [] }),
        create: async (data: { source: string; parts: ImportPart[] }) => {
          calls.records.push(data);
          recordSeq += 1;
          return { record: { id: `rec${recordSeq}` } };
        },
        remove: async () => ({ success: true }),
        get: async () => {
          throw new Error("unused");
        },
      },
      prompts: { templates: async () => [] },
    } as unknown as ServerApi;
    const credentials: CredentialSource[] = [
      {
        id: "cli-claude-code",
        provider: "anthropic",
        sourceType: "cli_oauth",
        sourceName: "Claude Code",
        status: "available",
      },
    ];
    const store = createImportStore({
      api,
      discoverMcp: async () => [mcp("playwright", ["Claude Code"]), mcp("github", ["Claude Code"])],
      discoverSkills: async () => [skill("pdf", ["Claude Code"])],
      skillsDisabledList: async () => ["pdf"],
      skillsSetEnabled: async (name) => {
        calls.enabled.push(name);
      },
      listCredentialSources: async () => credentials,
      onConversationsImported: async () => {
        calls.conversationsReloaded += 1;
      },
    });
    return { store, calls };
  }

  test("batches conversations at 500 per run, attaching instructions to the first batch only", async () => {
    const { store, calls } = makeDeps();
    await store.getState().scan();
    await store.getState().loadConversationList("claude-code");
    expect(store.getState().conversationLists["claude-code"]).toEqual([]);
    const ids = Array.from({ length: 700 }, (_, i) => `s${i}`);
    const outcome = await store.getState().runImport("claude-code", {
      conversations: ids,
      instructions: true,
    });
    // The cached picker list is dropped so `alreadyImported` is recomputed on next open.
    expect(store.getState().conversationLists["claude-code"]).toBe(undefined);
    expect(calls.runs).toHaveLength(2);
    expect(calls.runs[0].parts.instructions).toBe(true);
    expect(calls.runs[1].parts.instructions).toBe(undefined);
    expect((calls.runs[1].parts.conversations as { sessionIds: string[] }).sessionIds).toHaveLength(
      200,
    );
    expect(outcome.recordIds).toEqual(["rec1", "rec2"]);
    const conv = outcome.parts.find((p) => p.type === "conversations");
    expect(conv?.imported).toBe(700);
    expect(conv?.items).toHaveLength(200);
    expect(calls.conversationsReloaded).toBe(1);
  });

  test("desktop parts create MCP (skipping existing), enable skills, create channels and write one record", async () => {
    const { store, calls } = makeDeps();
    await store.getState().scan();
    const outcome = await store.getState().runImport("claude-code", {
      mcp: ["sig:playwright", "sig:github"],
      skills: ["pdf"],
      credentials: ["cli-claude-code"],
    });
    expect(calls.runs).toHaveLength(0);
    expect(calls.created.map((c) => c.name)).toEqual(["playwright"]);
    expect(calls.created[0].importedFrom).toBe("claude-code");
    expect(calls.enabled).toEqual(["pdf"]);
    expect(calls.channels).toEqual(["Claude Code"]);
    expect(calls.records).toHaveLength(1);
    expect(calls.records[0].source).toBe("claude-code");
    expect(calls.records[0].parts.map((p) => p.type)).toEqual(["mcp", "skills", "credentials"]);
    const mcpPart = outcome.parts.find((p) => p.type === "mcp");
    expect(mcpPart?.imported).toBe(1);
    expect(mcpPart?.skipped).toBe(1);
    expect(mcpPart?.items[0]?.link).toEqual({ kind: "mcp", id: "mcp-playwright" });
    const chPart = outcome.parts.find((p) => p.type === "credentials");
    expect(chPart?.items[0]?.link).toEqual({ kind: "channel", id: "ch-Claude Code" });
    expect(store.getState().running).toBe(false);
    expect(store.getState().progress).toBe(null);
  });
});
