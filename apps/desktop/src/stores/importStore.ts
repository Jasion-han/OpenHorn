import { IMPORT_PART_ITEMS_LIMIT, LOCAL_IMPORT_RUN_MAX_CONVERSATIONS } from "shared/constants";
import type {
  ImportPart,
  ImportPartItem,
  ImportPartType,
  ImportSource,
  LocalImportConversationSummary,
  LocalImportScanResult,
  LocalImportServerSource,
  PromptTemplate,
} from "shared/types";
import { create } from "zustand";
import { createCliOAuthChannel } from "../lib/cliOAuthChannel";
import { type CredentialSource, listCredentialSources } from "../lib/credentialApi";
import { formatImportLabel, getImportLabel } from "../lib/i18n/agent";
import { createServerApi, type ServerApi } from "../lib/serverApi";
import {
  type DiscoveredMcpServer,
  type DiscoveredSkill,
  discoverMcpConfigs,
  discoverSkills,
  skillsDisabledList,
  skillsSetEnabled,
} from "../lib/tauriBridge";
import type { ApiImportRecord } from "../types/chat";
import { useChatStore } from "./chatStore";

// ---------------------------------------------------------------------------
// Client label → ImportSource
// ---------------------------------------------------------------------------

/**
 * Rust discovery (`mcp_discover_configs` / `skills_discover`) and the server's
 * credential detection tag rows with a human client label. This maps those
 * labels onto the shared `ImportSource` ids. Labels with no source (e.g.
 * "导入的文件") return null and are bucketed under `file` by the aggregator.
 */
const CLIENT_LABEL_TO_SOURCE: Record<string, ImportSource> = {
  "claude code": "claude-code",
  "codex cli": "codex",
  codex: "codex",
  "gemini cli": "gemini",
  "cc-switch": "cc-switch",
  "cc switch": "cc-switch",
  opencode: "opencode",
  cursor: "cursor",
  "vs code": "vscode",
  vscode: "vscode",
  "claude desktop": "claude-desktop",
  continue: "continue",
};

export function importSourceFromClientLabel(label: string): ImportSource | null {
  return CLIENT_LABEL_TO_SOURCE[label.trim().toLowerCase()] ?? null;
}

/** Display order of source rows; `file` (the catch-all) always comes last. */
export const IMPORT_SOURCE_ORDER: ImportSource[] = [
  "claude-code",
  "codex",
  "gemini",
  "cc-switch",
  "opencode",
  "cursor",
  "vscode",
  "claude-desktop",
  "continue",
  "file",
];

export const LOCAL_IMPORT_SERVER_SOURCES: LocalImportServerSource[] = [
  "claude-code",
  "codex",
  "gemini",
];

export function isLocalImportServerSource(source: ImportSource): source is LocalImportServerSource {
  return (LOCAL_IMPORT_SERVER_SOURCES as ImportSource[]).includes(source);
}

// ---------------------------------------------------------------------------
// Scan aggregation
// ---------------------------------------------------------------------------

export interface ImportMcpEntry extends DiscoveredMcpServer {
  /** A server with the same name is already configured. */
  exists: boolean;
}

export interface ImportSkillEntry extends DiscoveredSkill {
  /** Not in the disabled list — "importing" it would be a no-op. */
  enabled: boolean;
}

export interface ImportCredentialEntry extends CredentialSource {
  /** A channel named after this source already exists. */
  exists: boolean;
  /** env-var keys are listed for information only and never imported. */
  importable: boolean;
}

export interface ImportSourceSummary {
  source: ImportSource;
  available: boolean;
  conversations?: { count: number };
  instructions?: { count: number; path?: string };
  prompts?: { count: number };
  mcp?: { entries: ImportMcpEntry[]; newCount: number };
  skills?: { entries: ImportSkillEntry[]; newCount: number };
  credentials?: { entries: ImportCredentialEntry[]; newCount: number };
}

export interface ScanAggregateInput {
  server: LocalImportScanResult | null;
  mcp: DiscoveredMcpServer[];
  skills: DiscoveredSkill[];
  /** Lower-cased skill names from `skills-enabled.json`'s disabled list. */
  disabledSkills: Set<string>;
  credentials: CredentialSource[];
  existingMcpNames: Set<string>;
  existingChannelNames: Set<string>;
}

/**
 * The single row a discovered MCP / skill entry belongs to. Rust already
 * dedupes by canonical path / signature and tags `client` with the owner (the
 * first client scanned); unmapped labels (picked file) fall back to `file`.
 */
function ownerSource(client: string): ImportSource {
  return importSourceFromClientLabel(client) ?? "file";
}

/** Whether a summary has anything at all to show (drives `available` for `file`). */
export function summaryHasContent(summary: ImportSourceSummary): boolean {
  return Boolean(
    (summary.conversations && summary.conversations.count > 0) ||
      (summary.instructions && summary.instructions.count > 0) ||
      (summary.prompts && summary.prompts.count > 0) ||
      (summary.mcp && summary.mcp.entries.length > 0) ||
      (summary.skills && summary.skills.entries.length > 0) ||
      (summary.credentials && summary.credentials.entries.length > 0),
  );
}

/** Number of importable-but-not-yet-imported things across all parts. */
export function summaryNewCount(summary: ImportSourceSummary): number {
  return (
    (summary.conversations?.count ?? 0) +
    (summary.instructions?.count ?? 0) +
    (summary.prompts?.count ?? 0) +
    (summary.mcp?.newCount ?? 0) +
    (summary.skills?.newCount ?? 0) +
    (summary.credentials?.newCount ?? 0)
  );
}

/**
 * Folds the server scan (conversations / instructions / prompts) and the
 * desktop-side discovery (MCP / skills / credentials) into one row per source.
 * Pure so it can be unit-tested without Tauri or a server.
 */
export function aggregateScan(input: ScanAggregateInput): ImportSourceSummary[] {
  const byId = new Map<ImportSource, ImportSourceSummary>();
  const ensure = (source: ImportSource): ImportSourceSummary => {
    let summary = byId.get(source);
    if (!summary) {
      summary = { source, available: false };
      byId.set(source, summary);
    }
    return summary;
  };

  for (const scanned of input.server?.sources ?? []) {
    const summary = ensure(scanned.source);
    summary.available = summary.available || scanned.available;
    if (scanned.parts.conversations) {
      summary.conversations = { count: scanned.parts.conversations.count };
    }
    if (scanned.parts.instructions) {
      summary.instructions = {
        count: scanned.parts.instructions.count,
        path: scanned.parts.instructions.path,
      };
    }
    if (scanned.parts.prompts) summary.prompts = { count: scanned.parts.prompts.count };
  }

  // MCP / skills: each entry is listed once, under the client that owns it
  // (`entry.client`). Tools that CC Switch symlinks into several clients are
  // NOT fanned out to every client row; `entry.clients` still records where
  // else they appear and is shown as detail in the dialog / records.
  const seenMcp = new Set<string>();
  for (const server of input.mcp) {
    const source = ownerSource(server.client);
    const key = `${source}:${server.signature}`;
    if (seenMcp.has(key)) continue;
    seenMcp.add(key);
    const summary = ensure(source);
    summary.available = true;
    const part = summary.mcp ?? { entries: [], newCount: 0 };
    const exists = input.existingMcpNames.has(server.name);
    part.entries.push({ ...server, exists });
    if (!exists) part.newCount += 1;
    summary.mcp = part;
  }

  const seenSkill = new Set<string>();
  for (const skill of input.skills) {
    const nameKey = skill.name.trim().toLowerCase();
    const source = ownerSource(skill.client);
    const key = `${source}:${nameKey}`;
    if (seenSkill.has(key)) continue;
    seenSkill.add(key);
    const summary = ensure(source);
    summary.available = true;
    const part = summary.skills ?? { entries: [], newCount: 0 };
    const enabled = !input.disabledSkills.has(nameKey);
    part.entries.push({ ...skill, enabled });
    if (!enabled) part.newCount += 1;
    summary.skills = part;
  }

  for (const credential of input.credentials) {
    const importable = credential.sourceType === "cli_oauth";
    const source = importable ? importSourceFromClientLabel(credential.sourceName) : null;
    const summary = ensure(source ?? "file");
    summary.available = true;
    const part = summary.credentials ?? { entries: [], newCount: 0 };
    const exists = input.existingChannelNames.has(credential.sourceName);
    part.entries.push({ ...credential, exists, importable });
    if (importable && !exists) part.newCount += 1;
    summary.credentials = part;
  }

  const ordered: ImportSourceSummary[] = [];
  for (const source of IMPORT_SOURCE_ORDER) {
    const summary = byId.get(source);
    if (!summary) continue;
    if (source === "file") summary.available = summaryHasContent(summary);
    ordered.push(summary);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

export interface ImportSelection {
  /** Explicit session ids; the dialog resolves "all" to ids before calling run. */
  conversations?: string[];
  instructions?: boolean;
  prompts?: boolean;
  /** MCP tool signatures. */
  mcp?: string[];
  /** Skill names. */
  skills?: string[];
  /** Credential source ids. */
  credentials?: string[];
}

export interface ImportRunOutcome {
  parts: ImportPart[];
  errors: string[];
  recordIds: string[];
}

export interface ImportProgress {
  done: number;
  total: number;
  /** True while the desktop-side MCP / skills / credentials step is running. */
  desktop: boolean;
}

export function chunkSessionIds(
  ids: string[],
  size = LOCAL_IMPORT_RUN_MAX_CONVERSATIONS,
): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Sums parts of the same type; items are concatenated up to the shared cap. */
export function mergeParts(lists: ImportPart[][]): ImportPart[] {
  const byType = new Map<ImportPartType, ImportPart>();
  for (const list of lists) {
    for (const part of list) {
      const current = byType.get(part.type);
      if (!current) {
        byType.set(part.type, { ...part, items: part.items.slice(0, IMPORT_PART_ITEMS_LIMIT) });
        continue;
      }
      current.imported += part.imported;
      current.skipped += part.skipped;
      current.needsAction += part.needsAction;
      if (part.note && !current.note) current.note = part.note;
      const room = IMPORT_PART_ITEMS_LIMIT - current.items.length;
      if (room > 0) current.items.push(...part.items.slice(0, room));
    }
  }
  return [...byType.values()];
}

function makePart(type: ImportPartType, items: ImportPartItem[]): ImportPart {
  let imported = 0;
  let skipped = 0;
  let needsAction = 0;
  for (const item of items) {
    if (item.status === "imported") imported += 1;
    else if (item.status === "skipped") skipped += 1;
    else needsAction += 1;
  }
  return { type, imported, skipped, needsAction, items: items.slice(0, IMPORT_PART_ITEMS_LIMIT) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Needs-action digest
// ---------------------------------------------------------------------------

export interface NeedsActionEntry {
  recordId: string;
  source: ImportSource;
  partType: ImportPartType;
  item: ImportPartItem;
}

/** Items still marked `needsAction` across the most recent records. */
export function collectNeedsAction(records: ApiImportRecord[], limit = 20): NeedsActionEntry[] {
  const out: NeedsActionEntry[] = [];
  for (const record of records.slice(0, limit)) {
    for (const part of record.parts) {
      for (const item of part.items) {
        if (item.status !== "needsAction") continue;
        out.push({ recordId: record.id, source: record.source, partType: part.type, item });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ImportStoreDeps {
  api?: ServerApi;
  discoverMcp?: () => Promise<DiscoveredMcpServer[]>;
  discoverSkills?: () => Promise<DiscoveredSkill[]>;
  skillsDisabledList?: () => Promise<string[]>;
  skillsSetEnabled?: (name: string, enabled: boolean) => Promise<void>;
  listCredentialSources?: () => Promise<CredentialSource[]>;
  /** Called after conversations were imported so the sidebar picks them up. */
  onConversationsImported?: () => Promise<void>;
}

export interface ImportState {
  scanning: boolean;
  scanned: boolean;
  scanError: string | null;
  sources: ImportSourceSummary[];
  conversationLists: Partial<Record<LocalImportServerSource, LocalImportConversationSummary[]>>;
  conversationListLoading: LocalImportServerSource | null;

  running: boolean;
  progress: ImportProgress | null;
  lastOutcome: ImportRunOutcome | null;

  records: ApiImportRecord[];
  recordsCursor: string | null;
  recordsLoading: boolean;
  recordsError: string | null;

  promptTemplates: PromptTemplate[];

  scan: () => Promise<void>;
  /**
   * Merges MCP entries parsed from a user-picked config file into the `file`
   * row so they can go through the same import dialog. Returns that row.
   */
  addPickedMcp: (found: DiscoveredMcpServer[]) => ImportSourceSummary;
  loadConversationList: (source: LocalImportServerSource, force?: boolean) => Promise<void>;
  runImport: (source: ImportSource, selection: ImportSelection) => Promise<ImportRunOutcome>;
  loadRecords: () => Promise<void>;
  loadMoreRecords: () => Promise<void>;
  removeRecord: (id: string) => Promise<void>;
  loadPromptTemplates: () => Promise<void>;
}

async function settled<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export function createImportStore(deps: ImportStoreDeps = {}) {
  const api = deps.api ?? createServerApi();
  const discoverMcp = deps.discoverMcp ?? discoverMcpConfigs;
  const discoverSkillsImpl = deps.discoverSkills ?? discoverSkills;
  const disabledList = deps.skillsDisabledList ?? skillsDisabledList;
  const setSkillEnabled = deps.skillsSetEnabled ?? skillsSetEnabled;
  const listCredentials = deps.listCredentialSources ?? listCredentialSources;
  const onConversationsImported =
    deps.onConversationsImported ?? (() => useChatStore.getState().loadConversations());

  return create<ImportState>((set, get) => ({
    scanning: false,
    scanned: false,
    scanError: null,
    sources: [],
    conversationLists: {},
    conversationListLoading: null,

    running: false,
    progress: null,
    lastOutcome: null,

    records: [],
    recordsCursor: null,
    recordsLoading: false,
    recordsError: null,

    promptTemplates: [],

    async scan() {
      if (get().scanning) return;
      set({ scanning: true, scanError: null });
      let serverError: string | null = null;
      const [server, mcp, skills, disabled, credentials, mcpServers, channels] = await Promise.all([
        api.localImport.scan().catch((error: unknown) => {
          serverError = errorMessage(error);
          return null;
        }),
        settled(discoverMcp(), [] as DiscoveredMcpServer[]),
        settled(discoverSkillsImpl(), [] as DiscoveredSkill[]),
        settled(disabledList(), [] as string[]),
        settled(listCredentials(), [] as CredentialSource[]),
        settled(api.mcp.listServers(), { servers: [] as unknown[] }),
        settled(api.channels.list(), { channels: [] as Array<{ name: string }> }),
      ]);
      const existingMcpNames = new Set(
        (mcpServers.servers as Array<{ name?: unknown }>)
          .map((row) => (typeof row?.name === "string" ? row.name : null))
          .filter((name): name is string => name !== null),
      );
      const sources = aggregateScan({
        server,
        mcp,
        skills,
        disabledSkills: new Set(disabled.map((name) => name.trim().toLowerCase())),
        credentials,
        existingMcpNames,
        existingChannelNames: new Set(channels.channels.map((channel) => channel.name)),
      });
      set({ sources, scanning: false, scanned: true, scanError: serverError });
    },

    addPickedMcp(found) {
      const existingNames = new Set<string>();
      for (const row of get().sources) {
        for (const entry of row.mcp?.entries ?? []) if (entry.exists) existingNames.add(entry.name);
      }
      const current = get().sources.find((row) => row.source === "file") ?? {
        source: "file" as const,
        available: true,
      };
      const part = current.mcp ?? { entries: [], newCount: 0 };
      const seen = new Set(part.entries.map((entry) => entry.signature));
      for (const server of found) {
        if (seen.has(server.signature)) continue;
        seen.add(server.signature);
        const exists = existingNames.has(server.name);
        part.entries.push({ ...server, exists });
        if (!exists) part.newCount += 1;
      }
      const next: ImportSourceSummary = { ...current, available: true, mcp: { ...part } };
      set((state) => {
        const others = state.sources.filter((row) => row.source !== "file");
        return { sources: [...others, next] };
      });
      return next;
    },

    async loadConversationList(source, force = false) {
      if (!force && get().conversationLists[source]) return;
      set({ conversationListLoading: source });
      try {
        const { conversations } = await api.localImport.listConversations(source);
        set((state) => ({
          conversationLists: { ...state.conversationLists, [source]: conversations },
          conversationListLoading: null,
        }));
      } catch {
        set({ conversationListLoading: null });
      }
    },

    async runImport(source, selection) {
      const partLists: ImportPart[][] = [];
      const errors: string[] = [];
      const recordIds: string[] = [];
      const sessionIds = selection.conversations ?? [];
      const batches = chunkSessionIds(sessionIds);
      const serverSelected =
        isLocalImportServerSource(source) &&
        (batches.length > 0 || selection.instructions || selection.prompts);
      const desktopSelected = Boolean(
        selection.mcp?.length || selection.skills?.length || selection.credentials?.length,
      );

      set({
        running: true,
        lastOutcome: null,
        progress: {
          done: 0,
          total: Math.max(batches.length, serverSelected ? 1 : 0),
          desktop: false,
        },
      });

      try {
        if (serverSelected && isLocalImportServerSource(source)) {
          // Instructions / prompts ride along with the first batch only; later
          // batches carry conversations alone (each run writes its own record).
          const runs = batches.length > 0 ? batches : [null];
          for (let index = 0; index < runs.length; index += 1) {
            const batch = runs[index];
            const parts: {
              conversations?: { sessionIds: string[] };
              instructions?: true;
              prompts?: true;
            } = {};
            if (batch) parts.conversations = { sessionIds: batch };
            if (index === 0 && selection.instructions) parts.instructions = true;
            if (index === 0 && selection.prompts) parts.prompts = true;
            try {
              const result = await api.localImport.run({ source, parts });
              partLists.push(result.parts);
              errors.push(...result.errors);
              recordIds.push(result.recordId);
            } catch (error) {
              errors.push(errorMessage(error));
            }
            set({ progress: { done: index + 1, total: runs.length, desktop: false } });
          }
        }

        if (desktopSelected) {
          set((state) => ({
            progress: { ...(state.progress ?? { done: 0, total: 0 }), desktop: true },
          }));
          const summary = get().sources.find((row) => row.source === source);
          const desktopParts: ImportPart[] = [];

          if (selection.mcp?.length && summary?.mcp) {
            const wanted = new Set(selection.mcp);
            const items: ImportPartItem[] = [];
            const done = new Set<string>();
            for (const entry of summary.mcp.entries) {
              if (!wanted.has(entry.signature) || done.has(entry.signature)) continue;
              done.add(entry.signature);
              const detail = formatImportLabel("import.detail.clients", {
                clients: entry.clients.join(" · "),
              });
              if (entry.exists) {
                items.push({
                  label: entry.name,
                  detail: getImportLabel("import.detail.mcpExists"),
                  status: "skipped",
                });
                continue;
              }
              try {
                const { server } = await api.mcp.createServer({
                  name: entry.name,
                  type: entry.type,
                  config: entry.config,
                  importedFrom: source,
                });
                items.push({
                  label: entry.name,
                  detail,
                  status: "imported",
                  link: { kind: "mcp", id: server.id },
                });
              } catch (error) {
                items.push({
                  label: entry.name,
                  detail: formatImportLabel("import.detail.mcpFailed", {
                    message: errorMessage(error),
                  }),
                  status: "needsAction",
                  link: { kind: "mcp" },
                });
              }
            }
            desktopParts.push(makePart("mcp", items));
          }

          if (selection.skills?.length && summary?.skills) {
            const wanted = new Set(selection.skills);
            const items: ImportPartItem[] = [];
            for (const entry of summary.skills.entries) {
              if (!wanted.has(entry.name)) continue;
              if (entry.enabled) {
                items.push({
                  label: entry.name,
                  detail: getImportLabel("import.detail.skillAlreadyEnabled"),
                  status: "skipped",
                  link: { kind: "skill", id: entry.name },
                });
                continue;
              }
              try {
                await setSkillEnabled(entry.name, true);
                items.push({
                  label: entry.name,
                  detail: getImportLabel("import.detail.skillEnabled"),
                  status: "imported",
                  link: { kind: "skill", id: entry.name },
                });
              } catch (error) {
                items.push({
                  label: entry.name,
                  detail: formatImportLabel("import.detail.skillFailed", {
                    message: errorMessage(error),
                  }),
                  status: "needsAction",
                  link: { kind: "skill", id: entry.name },
                });
              }
            }
            desktopParts.push(makePart("skills", items));
          }

          if (selection.credentials?.length && summary?.credentials) {
            const wanted = new Set(selection.credentials);
            const items: ImportPartItem[] = [];
            for (const entry of summary.credentials.entries) {
              if (!wanted.has(entry.id)) continue;
              if (!entry.importable) {
                items.push({
                  label: entry.sourceName,
                  detail: getImportLabel("import.detail.credentialEnvOnly"),
                  status: "skipped",
                });
                continue;
              }
              if (entry.exists) {
                items.push({
                  label: entry.sourceName,
                  detail: getImportLabel("import.detail.channelExists"),
                  status: "skipped",
                  link: { kind: "channel" },
                });
                continue;
              }
              try {
                const { channel } = await createCliOAuthChannel(api, entry);
                items.push({
                  label: entry.sourceName,
                  detail: formatImportLabel("import.detail.channelCreated", {
                    provider: entry.provider,
                  }),
                  status: "imported",
                  link: { kind: "channel", id: channel.id },
                });
              } catch (error) {
                items.push({
                  label: entry.sourceName,
                  detail: formatImportLabel("import.detail.channelFailed", {
                    message: errorMessage(error),
                  }),
                  status: "needsAction",
                  link: { kind: "channel" },
                });
              }
            }
            desktopParts.push(makePart("credentials", items));
          }

          if (desktopParts.length > 0) {
            partLists.push(desktopParts);
            try {
              const { record } = await api.importRecords.create({
                source,
                kind: "local",
                parts: desktopParts,
              });
              recordIds.push(record.id);
            } catch (error) {
              errors.push(errorMessage(error));
            }
          }
        }
      } finally {
        set({ running: false, progress: null });
      }

      const outcome: ImportRunOutcome = { parts: mergeParts(partLists), errors, recordIds };
      set({ lastOutcome: outcome });

      // Refresh everything the import may have changed. Conversation lists are
      // dropped (not reloaded) so `alreadyImported` is recomputed on next open.
      const importedConversations = outcome.parts.some(
        (part) => part.type === "conversations" && part.imported > 0,
      );
      set((state) => {
        const lists = { ...state.conversationLists };
        if (isLocalImportServerSource(source)) delete lists[source];
        return { conversationLists: lists };
      });
      await Promise.all([
        get().loadRecords(),
        get().scan(),
        selection.prompts ? get().loadPromptTemplates() : Promise.resolve(),
        importedConversations ? settled(onConversationsImported(), undefined) : Promise.resolve(),
      ]);
      return outcome;
    },

    async loadRecords() {
      set({ recordsLoading: true, recordsError: null });
      try {
        const { records, nextCursor } = await api.importRecords.list({ limit: 20 });
        set({ records, recordsCursor: nextCursor ?? null, recordsLoading: false });
      } catch (error) {
        set({ recordsLoading: false, recordsError: errorMessage(error) });
      }
    },

    async loadMoreRecords() {
      const cursor = get().recordsCursor;
      if (!cursor || get().recordsLoading) return;
      set({ recordsLoading: true, recordsError: null });
      try {
        const { records, nextCursor } = await api.importRecords.list({ limit: 20, cursor });
        set((state) => {
          const seen = new Set(state.records.map((record) => record.id));
          return {
            records: [...state.records, ...records.filter((record) => !seen.has(record.id))],
            recordsCursor: nextCursor ?? null,
            recordsLoading: false,
          };
        });
      } catch (error) {
        set({ recordsLoading: false, recordsError: errorMessage(error) });
      }
    },

    async removeRecord(id) {
      await api.importRecords.remove(id);
      set((state) => ({ records: state.records.filter((record) => record.id !== id) }));
    },

    async loadPromptTemplates() {
      try {
        const promptTemplates = await api.prompts.templates();
        set({ promptTemplates });
      } catch {
        // keep whatever we had — the slash panel degrades to no prompt group
      }
    },
  }));
}

export const useImportStore = createImportStore();
