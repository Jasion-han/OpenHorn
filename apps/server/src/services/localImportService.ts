/**
 * Local AI-client import — scans `~/.claude`, `~/.codex`, `~/.gemini` and
 * imports conversations (session jsonl), global instructions (CLAUDE.md /
 * AGENTS.md / GEMINI.md → settings `chat.systemPrompt`) and prompt templates
 * (`~/.claude/commands`, `~/.codex/prompts` → settings `prompts.templates`).
 *
 * Formats and filtering rules follow
 * `.trellis/tasks/09-11-import-center-history/research/local-history-formats.md`.
 *
 * Safety: every path read is resolved and checked to live under the home dir
 * (symlinks followed via realpath). Codex's `state_*.sqlite` is only ever read
 * as an index; the rollout jsonl files are the authoritative source.
 */
import { createReadStream, type Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createClient } from "@libsql/client";
import { conversations, messages, projects } from "db";
import { and, eq, inArray, lte } from "drizzle-orm";
import {
  GLOBAL_SYSTEM_PROMPT_SETTING_KEY,
  LOCAL_IMPORT_RUN_MAX_CONVERSATIONS,
  PROMPT_TEMPLATES_SETTING_KEY,
} from "shared/constants";
import type {
  ImportPart,
  ImportSource,
  LocalImportConversationListResult,
  LocalImportConversationSummary,
  LocalImportRunRequest,
  LocalImportRunResult,
  LocalImportScanResult,
  LocalImportScanSource,
  LocalImportServerSource,
  PromptTemplate,
} from "shared/types";
import { client, db } from "../db";
import { generateId } from "../utils";
import { addPartItem, createImportRecord, createPart, IMPORT_DETAIL } from "./importRecordsService";
import { getSettingValues, setSettingValue } from "./settingsService";

export interface LocalImportOptions {
  /** Override for tests; defaults to `os.homedir()`. */
  homeDir?: string;
}

const TITLE_MAX_LENGTH = 80;
const HEAD_SCAN_MAX_LINES = 400;

// ---------------------------------------------------------------------------
// Path / fs helpers
// ---------------------------------------------------------------------------

/** Canonical home dir (realpath'd so the symlink checks below compare like with like, e.g. /var → /private/var on macOS). */
async function resolveHome(options?: LocalImportOptions): Promise<string> {
  const raw = path.resolve(options?.homeDir ?? os.homedir());
  try {
    return await realpath(raw);
  } catch {
    return raw;
  }
}

function isUnder(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves symlinks and rejects anything that escapes `homeDir`. Returns null when missing. */
async function safeRealPath(homeDir: string, target: string): Promise<string | null> {
  if (!isUnder(homeDir, path.resolve(target))) return null;
  try {
    const real = await realpath(target);
    return isUnder(homeDir, real) ? real : null;
  } catch {
    return null;
  }
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return (await fileSize(filePath)) !== null;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Streams a file line by line; breaking out early closes the file (head scans must not leak fds). */
async function* iterLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function truncateTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_LENGTH) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

// ---------------------------------------------------------------------------
// Shared message model
// ---------------------------------------------------------------------------

interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
  model: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  createdAt: number;
}

interface ParsedSession {
  id: string;
  title: string;
  cwd: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ParsedMessage[];
}

interface SessionFile {
  id: string;
  filePath: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Claude Code (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl)
// ---------------------------------------------------------------------------

const CLAUDE_KEEP_LINE = /"type"\s*:\s*"(user|assistant|ai-title|summary)"/;
const CLAUDE_TITLE_LINE = /"type"\s*:\s*"(ai-title|summary)"/;
const CLAUDE_ENTRYPOINT = /"entrypoint"\s*:\s*"([a-z-]+)"/;
const CLAUDE_SKIPPED_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts"]);
/**
 * Sessions written by OpenHorn through Claude Code versions that predate the
 * `entrypoint` field carry no origin marker at all; the only trace is the
 * legacy scheduled-task prompt prefix (the same marker bootstrap.ts uses to
 * backfill `scheduled_task_id`). Their first prompt starts with it.
 */
const OPENHORN_LEGACY_TASK_PREFIX = "[定时任务自动触发]";

function isOpenHornLegacyPrompt(text: string): boolean {
  return text.trimStart().startsWith(OPENHORN_LEGACY_TASK_PREFIX);
}
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

async function listClaudeSessionFiles(homeDir: string): Promise<SessionFile[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects");
  const out: SessionFile[] = [];
  for (const projectEntry of await listDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    // Only top-level `<sessionId>.jsonl`; `<sessionId>/subagents/*.jsonl` are
    // sidechains and deliberately not imported.
    for (const entry of await listDir(projectDir)) {
      if (!entry.isFile() || !UUID_FILE.test(entry.name)) continue;
      const filePath = path.join(projectDir, entry.name);
      const size = await fileSize(filePath);
      if (!size) continue;
      out.push({ id: entry.name.slice(0, -".jsonl".length), filePath, sizeBytes: size });
    }
  }
  return out;
}

/**
 * System-generated user turns that Claude Code does not always flag with
 * `isMeta` (slash-command records, subagent notifications, local command
 * output, interruption markers, injected reminders). Matched per text block.
 */
const CLAUDE_INJECTED_PREFIXES = [
  "<task-notification>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "[Request interrupted by user",
];

function isClaudeInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return CLAUDE_INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Text of a user line, or null when it is not a real user prompt (meta / tool_result / compact summary / injected). */
function claudeUserText(obj: Record<string, unknown>): string | null {
  if (obj.isMeta === true || obj.isCompactSummary === true) return null;
  if (obj.toolUseResult !== undefined && obj.toolUseResult !== null) return null;
  const message = isRecord(obj.message) ? obj.message : null;
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() && !isClaudeInjected(content) ? content : null;
  }
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") return null;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (isClaudeInjected(block.text)) continue;
    texts.push(block.text);
  }
  const joined = texts.join("\n");
  return joined.trim() ? joined : null;
}

interface ClaudeAssistantGroup {
  messageId: string | null;
  texts: string[];
  model: string | null;
  usage: ParsedMessage["usage"];
  createdAt: number;
}

function claudeUsage(raw: unknown): ParsedMessage["usage"] {
  if (!isRecord(raw)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const promptTokens =
    n(raw.input_tokens) + n(raw.cache_read_input_tokens) + n(raw.cache_creation_input_tokens);
  const completionTokens = n(raw.output_tokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

interface ClaudeHead {
  entrypoint: string | null;
  cwd: string | null;
  firstUserText: string | null;
  aiTitle: string | null;
  firstTimestamp: number | null;
}

/** Cheap partial read: enough to know whether to skip the file and what to call it. */
async function readClaudeHead(filePath: string): Promise<ClaudeHead> {
  const head: ClaudeHead = {
    entrypoint: null,
    cwd: null,
    firstUserText: null,
    aiTitle: null,
    firstTimestamp: null,
  };
  let lines = 0;
  for await (const line of iterLines(filePath)) {
    lines++;
    if (!head.entrypoint) {
      const m = CLAUDE_ENTRYPOINT.exec(line);
      if (m) head.entrypoint = m[1];
    }
    // Once the first prompt is known only title lines are worth parsing: the
    // remaining user/assistant lines in the head are tool payloads (large).
    const keep = head.firstUserText ? CLAUDE_TITLE_LINE.test(line) : CLAUDE_KEEP_LINE.test(line);
    if (keep) {
      const obj = parseJsonLine(line);
      if (obj) {
        if (obj.type === "ai-title" && typeof obj.aiTitle === "string") head.aiTitle = obj.aiTitle;
        else if (obj.type === "summary" && typeof obj.summary === "string") {
          head.aiTitle = obj.summary;
        } else if (obj.type === "user" || obj.type === "assistant") {
          if (!head.cwd) head.cwd = asString(obj.cwd);
          if (head.firstTimestamp === null) head.firstTimestamp = parseTimestamp(obj.timestamp);
          if (obj.type === "user" && !head.firstUserText) {
            head.firstUserText = claudeUserText(obj);
          }
        }
      }
    }
    // ai-title is written early (median ~line 20 in practice) but after the
    // first prompt; keep going a bounded distance to pick it up for the list.
    if (head.firstUserText && head.entrypoint && head.aiTitle) break;
    if (lines >= HEAD_SCAN_MAX_LINES) break;
  }
  return head;
}

function isClaudeHeadImportable(head: ClaudeHead): boolean {
  if (head.entrypoint && CLAUDE_SKIPPED_ENTRYPOINTS.has(head.entrypoint)) return false;
  if (!head.firstUserText) return false;
  return !isOpenHornLegacyPrompt(head.firstUserText);
}

async function parseClaudeSession(file: SessionFile): Promise<ParsedSession | null> {
  let title: string | null = null;
  let firstUserText: string | null = null;
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let model: string | null = null;
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  const out: ParsedMessage[] = [];
  let group: ClaudeAssistantGroup | null = null;

  const flush = () => {
    if (!group) return;
    const content = group.texts.join("\n");
    if (content.trim()) {
      out.push({
        role: "assistant",
        content,
        model: group.model,
        usage: group.usage,
        createdAt: group.createdAt,
      });
    }
    group = null;
  };

  for await (const line of iterLines(file.filePath)) {
    if (!entrypoint) {
      const m = CLAUDE_ENTRYPOINT.exec(line);
      if (m) {
        entrypoint = m[1];
        if (CLAUDE_SKIPPED_ENTRYPOINTS.has(entrypoint)) return null;
      }
    }
    if (!CLAUDE_KEEP_LINE.test(line)) continue;
    const obj = parseJsonLine(line);
    if (!obj) continue;

    if (obj.type === "ai-title") {
      if (typeof obj.aiTitle === "string" && obj.aiTitle.trim()) title = obj.aiTitle;
      continue;
    }
    if (obj.type === "summary") {
      if (typeof obj.summary === "string" && obj.summary.trim() && !title) title = obj.summary;
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;

    const ts = parseTimestamp(obj.timestamp) ?? updatedAt ?? Date.now();
    if (createdAt === null) createdAt = ts;
    updatedAt = ts;
    if (!cwd) cwd = asString(obj.cwd);

    if (obj.type === "user") {
      const text = claudeUserText(obj);
      if (!text) continue;
      flush();
      if (!firstUserText) {
        if (isOpenHornLegacyPrompt(text)) return null;
        firstUserText = text;
      }
      out.push({ role: "user", content: text, model: null, usage: null, createdAt: ts });
      continue;
    }

    // assistant
    if (obj.isApiErrorMessage === true) continue;
    const message = isRecord(obj.message) ? obj.message : null;
    if (!message) continue;
    const messageId = asString(message.id);
    if (!group || group.messageId === null || group.messageId !== messageId) {
      flush();
      group = { messageId, texts: [], model: null, usage: null, createdAt: ts };
    }
    const g: ClaudeAssistantGroup = group;
    const msgModel = asString(message.model);
    if (msgModel) {
      g.model = msgModel;
      model = msgModel;
    }
    if (!g.usage) g.usage = claudeUsage(message.usage);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          g.texts.push(block.text);
        }
      }
    } else if (typeof message.content === "string") {
      g.texts.push(message.content);
    }
  }
  flush();

  if (!firstUserText || out.length === 0 || createdAt === null || updatedAt === null) return null;
  return {
    id: file.id,
    title: truncateTitle(title || firstUserText),
    cwd,
    model,
    createdAt,
    updatedAt,
    messages: out,
  };
}

// ---------------------------------------------------------------------------
// Codex (~/.codex/sessions/Y/M/D/rollout-<ts>-<uuid>.jsonl + state_*.sqlite index)
// ---------------------------------------------------------------------------

const CODEX_ROLLOUT_FILE =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CODEX_SUBAGENT_FILE =
  /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CODEX_KEEP_LINE =
  /"type"\s*:\s*"(session_meta|turn_context)"|"type"\s*:\s*"message"|"type"\s*:\s*"token_count"/;
const CODEX_INJECTED_PREFIXES = [
  "<environment_context>",
  "<INSTRUCTIONS>",
  "# AGENTS",
  "<turn_aborted>",
  "<permissions instructions>",
  "# Trellis Instructions",
  "<subagent_notification>",
  "# Files mentioned by the user",
  "# Repository Guidelines",
  "<app-context>",
  "<user_instructions>",
  "<image ",
  "<image>",
  "</image>",
];

function isCodexInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return CODEX_INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

async function listCodexRolloutFiles(homeDir: string): Promise<SessionFile[]> {
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  const out: SessionFile[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const m = CODEX_ROLLOUT_FILE.exec(entry.name);
      if (!m || CODEX_SUBAGENT_FILE.test(entry.name)) continue;
      const size = await fileSize(full);
      if (!size) continue;
      out.push({ id: m[1].toLowerCase(), filePath: full, sizeBytes: size });
    }
  };
  await walk(sessionsDir, 0);
  return out;
}

interface CodexIndexRow {
  title: string | null;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** Best-effort read of `threads` from the newest `state_<n>.sqlite`; empty map on any failure. */
async function readCodexIndex(homeDir: string): Promise<Map<string, CodexIndexRow>> {
  const index = new Map<string, CodexIndexRow>();
  const codexDir = path.join(homeDir, ".codex");
  let best: { version: number; name: string } | null = null;
  for (const entry of await listDir(codexDir)) {
    const m = /^state_(\d+)\.sqlite$/.exec(entry.name);
    if (!m || !entry.isFile()) continue;
    const version = Number(m[1]);
    if (!best || version > best.version) best = { version, name: entry.name };
  }
  if (!best) return index;

  const sqlite = createClient({ url: `file:${path.join(codexDir, best.name)}` });
  try {
    const result = await sqlite.execute(
      `SELECT id, name, title, first_user_message, cwd, created_at, updated_at FROM threads`,
    );
    for (const row of result.rows) {
      const id = asString(row.id)?.toLowerCase();
      if (!id) continue;
      const name = asString(row.name)?.trim();
      const title = asString(row.title)?.trim();
      const first = asString(row.first_user_message)?.trim();
      const toMs = (v: unknown) => (typeof v === "number" && v > 0 ? v * 1000 : null);
      index.set(id, {
        title: name || title || first || null,
        cwd: asString(row.cwd),
        createdAt: toMs(row.created_at),
        updatedAt: toMs(row.updated_at),
      });
    }
  } catch {
    // Locked / newer schema / missing table: fall back to jsonl-only scanning.
  } finally {
    sqlite.close();
  }
  return index;
}

interface CodexMeta {
  id: string | null;
  cwd: string | null;
  originator: string | null;
  threadSource: string | null;
  timestamp: number | null;
}

function codexMetaFromLine(obj: Record<string, unknown>): CodexMeta | null {
  if (obj.type !== "session_meta" || !isRecord(obj.payload)) return null;
  const p = obj.payload;
  return {
    id: asString(p.id)?.toLowerCase() ?? null,
    cwd: asString(p.cwd),
    originator: asString(p.originator),
    threadSource: asString(p.thread_source),
    timestamp: parseTimestamp(p.timestamp) ?? parseTimestamp(obj.timestamp),
  };
}

function isCodexSkippedMeta(meta: CodexMeta): boolean {
  return meta.originator === "openhorn" || meta.threadSource === "subagent";
}

/** User text after dropping injected blocks; null when nothing user-authored remains. */
function codexUserText(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.content)) return null;
  const texts: string[] = [];
  for (const block of payload.content) {
    if (!isRecord(block) || block.type !== "input_text" || typeof block.text !== "string") continue;
    if (isCodexInjected(block.text)) continue;
    texts.push(block.text);
  }
  const joined = texts.join("\n");
  return joined.trim() ? joined : null;
}

function codexAssistantText(payload: Record<string, unknown>): string | null {
  const phase = asString(payload.phase);
  if (phase && phase !== "final_answer") return null;
  if (!Array.isArray(payload.content)) return null;
  const texts: string[] = [];
  for (const block of payload.content) {
    if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  const joined = texts.join("\n");
  return joined.trim() ? joined : null;
}

function codexUsage(payload: Record<string, unknown>): ParsedMessage["usage"] {
  const info = isRecord(payload.info) ? payload.info : null;
  const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
  if (!last) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const promptTokens = n(last.input_tokens);
  const completionTokens = n(last.output_tokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

interface CodexHead {
  meta: CodexMeta | null;
  firstUserText: string | null;
}

async function readCodexHead(filePath: string): Promise<CodexHead> {
  const head: CodexHead = { meta: null, firstUserText: null };
  let lines = 0;
  for await (const line of iterLines(filePath)) {
    lines++;
    if (!CODEX_KEEP_LINE.test(line)) {
      if (lines >= HEAD_SCAN_MAX_LINES) break;
      continue;
    }
    const obj = parseJsonLine(line);
    if (obj) {
      if (!head.meta) {
        head.meta = codexMetaFromLine(obj);
      } else if (obj.type === "response_item" && isRecord(obj.payload)) {
        const p = obj.payload;
        if (p.type === "message" && p.role === "user") {
          const text = codexUserText(p);
          if (text) {
            head.firstUserText = text;
            break;
          }
        }
      }
    }
    if (lines >= HEAD_SCAN_MAX_LINES) break;
  }
  return head;
}

async function parseCodexSession(
  file: SessionFile,
  indexRow: CodexIndexRow | undefined,
): Promise<ParsedSession | null> {
  let meta: CodexMeta | null = null;
  let model: string | null = null;
  let firstUserText: string | null = null;
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  let pendingUsage: ParsedMessage["usage"] = null;
  const out: ParsedMessage[] = [];

  for await (const line of iterLines(file.filePath)) {
    if (!CODEX_KEEP_LINE.test(line)) continue;
    const obj = parseJsonLine(line);
    if (!obj || !isRecord(obj.payload)) continue;
    const payload = obj.payload;

    if (!meta) {
      meta = codexMetaFromLine(obj);
      if (meta) {
        if (isCodexSkippedMeta(meta)) return null;
        if (meta.timestamp !== null) createdAt = meta.timestamp;
      }
      if (obj.type === "session_meta") continue;
    }

    if (obj.type === "turn_context") {
      const m = asString(payload.model);
      if (m) model = m;
      continue;
    }
    if (obj.type === "event_msg") {
      if (payload.type === "token_count") pendingUsage = codexUsage(payload) ?? pendingUsage;
      continue;
    }
    if (obj.type !== "response_item" || payload.type !== "message") continue;

    const ts = parseTimestamp(obj.timestamp) ?? updatedAt ?? createdAt ?? Date.now();
    const role = payload.role;
    if (role === "user") {
      const text = codexUserText(payload);
      if (!text) continue;
      if (createdAt === null) createdAt = ts;
      updatedAt = ts;
      if (!firstUserText) firstUserText = text;
      out.push({ role: "user", content: text, model: null, usage: null, createdAt: ts });
    } else if (role === "assistant") {
      const text = codexAssistantText(payload);
      if (!text) continue;
      if (createdAt === null) createdAt = ts;
      updatedAt = ts;
      out.push({ role: "assistant", content: text, model, usage: pendingUsage, createdAt: ts });
      pendingUsage = null;
    }
    // developer role: always injected; dropped.
  }

  if (!firstUserText || out.length === 0 || createdAt === null || updatedAt === null) return null;
  const id = meta?.id ?? file.id;
  return {
    id,
    title: truncateTitle(indexRow?.title || firstUserText),
    cwd: meta?.cwd ?? indexRow?.cwd ?? null,
    model,
    createdAt,
    updatedAt,
    messages: out,
  };
}

// ---------------------------------------------------------------------------
// Instructions + prompt template files
// ---------------------------------------------------------------------------

function instructionsPath(homeDir: string, source: LocalImportServerSource): string {
  switch (source) {
    case "claude-code":
      return path.join(homeDir, ".claude", "CLAUDE.md");
    case "codex":
      return path.join(homeDir, ".codex", "AGENTS.md");
    case "gemini":
      return path.join(homeDir, ".gemini", "GEMINI.md");
  }
}

interface PromptFile {
  name: string;
  namespace: string | null;
  filePath: string;
}

async function listPromptFiles(
  homeDir: string,
  source: LocalImportServerSource,
): Promise<PromptFile[]> {
  const out: PromptFile[] = [];
  if (source === "claude-code") {
    const root = path.join(homeDir, ".claude", "commands");
    const walk = async (dir: string, ns: string[]) => {
      for (const entry of await listDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ns.length < 8) await walk(full, [...ns, entry.name]);
          continue;
        }
        if (!entry.name.endsWith(".md")) continue;
        const real = await safeRealPath(homeDir, full);
        if (!real || !(await fileSize(real))) continue;
        out.push({
          name: entry.name.slice(0, -3),
          namespace: ns.length ? ns.join(":") : null,
          filePath: real,
        });
      }
    };
    await walk(root, []);
  } else if (source === "codex") {
    const root = path.join(homeDir, ".codex", "prompts");
    for (const entry of await listDir(root)) {
      if (!entry.name.endsWith(".md")) continue;
      // Follow symlinks (e.g. prompts/x.md -> ~/.codex/x/commands/x.md) but stay in $HOME.
      const real = await safeRealPath(homeDir, path.join(root, entry.name));
      if (!real || !(await fileSize(real))) continue;
      out.push({ name: entry.name.slice(0, -3), namespace: null, filePath: real });
    }
  }
  return out;
}

export interface ParsedPromptFile {
  description?: string;
  argumentHint?: string;
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** YAML-ish frontmatter (`---` fenced `key: value` lines) + markdown body. */
export function parsePromptFile(raw: string): ParsedPromptFile {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: text.trim() };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { body: text.trim() };
  const out: ParsedPromptFile = {
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = unquote(line.slice(idx + 1));
    if (!value) continue;
    if (key === "description") out.description = value;
    else if (key === "argument-hint" || key === "argument_hint") out.argumentHint = value;
  }
  return out;
}

function parsePromptTemplates(raw: string | undefined): PromptTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is PromptTemplate =>
        isRecord(t) &&
        typeof t.id === "string" &&
        typeof t.name === "string" &&
        typeof t.body === "string" &&
        typeof t.source === "string",
    );
  } catch {
    return [];
  }
}

function promptTemplateKey(t: { source: string; name: string; namespace?: string | null }): string {
  return `${t.source}\u0000${t.namespace ?? ""}\u0000${t.name}`;
}

// ---------------------------------------------------------------------------
// Instructions merge (settings `chat.systemPrompt`)
// ---------------------------------------------------------------------------

const IMPORT_MARKER_PREFIX = "<!-- imported:";

export function instructionsMarker(source: ImportSource, basename: string): string {
  return `${IMPORT_MARKER_PREFIX} ${source} ${basename} -->`;
}

/**
 * Appends `text` under `marker`, or replaces the segment that already starts
 * with `marker` (bounded by the next `<!-- imported:` marker or end of text).
 */
export function mergeInstructions(
  existing: string | undefined,
  marker: string,
  text: string,
): { value: string; replaced: boolean } {
  const body = text.trim();
  const segment = `${marker}\n${body}`;
  const current = existing ?? "";
  const start = current.indexOf(marker);
  if (start < 0) {
    const base = current.trimEnd();
    return { value: base ? `${base}\n\n${segment}` : segment, replaced: false };
  }
  const afterMarker = start + marker.length;
  const nextIdx = current.indexOf(IMPORT_MARKER_PREFIX, afterMarker);
  const before = current.slice(0, start);
  const after = nextIdx < 0 ? "" : current.slice(nextIdx);
  const value = `${before}${segment}${after ? `\n\n${after}` : ""}`;
  return { value, replaced: true };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

async function scanClaudeConversationCount(homeDir: string): Promise<number> {
  let count = 0;
  for (const file of await listClaudeSessionFiles(homeDir)) {
    const head = await readClaudeHead(file.filePath);
    if (!isClaudeHeadImportable(head)) continue;
    count++;
  }
  return count;
}

async function scanCodexConversationCount(homeDir: string): Promise<number> {
  let count = 0;
  for (const file of await listCodexRolloutFiles(homeDir)) {
    const head = await readCodexHead(file.filePath);
    if (!head.meta || isCodexSkippedMeta(head.meta)) continue;
    if (!head.firstUserText) continue;
    count++;
  }
  return count;
}

async function scanInstructions(
  homeDir: string,
  source: LocalImportServerSource,
): Promise<{ count: number; path?: string }> {
  const filePath = instructionsPath(homeDir, source);
  const size = await fileSize(filePath);
  return size ? { count: 1, path: filePath } : { count: 0 };
}

export async function scanLocalSources(
  _userId: string,
  options?: LocalImportOptions,
): Promise<LocalImportScanResult> {
  const homeDir = await resolveHome(options);
  const sources: LocalImportScanSource[] = [];

  // claude-code
  {
    const available = await dirExists(path.join(homeDir, ".claude"));
    const entry: LocalImportScanSource = { source: "claude-code", available, parts: {} };
    if (available) {
      entry.parts.conversations = {
        count: await scanClaudeConversationCount(homeDir),
        handledBy: "server",
      };
      entry.parts.instructions = {
        ...(await scanInstructions(homeDir, "claude-code")),
        handledBy: "server",
      };
      entry.parts.prompts = {
        count: (await listPromptFiles(homeDir, "claude-code")).length,
        handledBy: "server",
      };
      entry.parts.mcp = { handledBy: "desktop" };
      entry.parts.skills = { handledBy: "desktop" };
    }
    sources.push(entry);
  }

  // codex
  {
    const available = await dirExists(path.join(homeDir, ".codex"));
    const entry: LocalImportScanSource = { source: "codex", available, parts: {} };
    if (available) {
      entry.parts.conversations = {
        count: await scanCodexConversationCount(homeDir),
        handledBy: "server",
      };
      entry.parts.instructions = {
        ...(await scanInstructions(homeDir, "codex")),
        handledBy: "server",
      };
      entry.parts.prompts = {
        count: (await listPromptFiles(homeDir, "codex")).length,
        handledBy: "server",
      };
      entry.parts.mcp = { handledBy: "desktop" };
      entry.parts.skills = { handledBy: "desktop" };
    }
    sources.push(entry);
  }

  // gemini (no session history format to import; instructions + desktop-side mcp/skills)
  {
    const available = await dirExists(path.join(homeDir, ".gemini"));
    const entry: LocalImportScanSource = { source: "gemini", available, parts: {} };
    if (available) {
      entry.parts.instructions = {
        ...(await scanInstructions(homeDir, "gemini")),
        handledBy: "server",
      };
      entry.parts.mcp = { handledBy: "desktop" };
      entry.parts.skills = { handledBy: "desktop" };
    }
    sources.push(entry);
  }

  // Desktop-only sources: the server just reports whether the directory exists.
  const desktopOnly: { source: ImportSource; dir: string }[] = [
    { source: "cc-switch", dir: path.join(homeDir, ".cc-switch") },
    { source: "opencode", dir: path.join(homeDir, ".config", "opencode") },
    { source: "cursor", dir: path.join(homeDir, ".cursor") },
    {
      source: "claude-desktop",
      dir: path.join(homeDir, "Library", "Application Support", "Claude"),
    },
    { source: "continue", dir: path.join(homeDir, ".continue") },
  ];
  for (const { source, dir } of desktopOnly) {
    const available = await dirExists(dir);
    const entry: LocalImportScanSource = { source, available, parts: {} };
    if (available) {
      entry.parts.mcp = { handledBy: "desktop" };
      if (source !== "claude-desktop" && source !== "cursor")
        entry.parts.skills = { handledBy: "desktop" };
    }
    sources.push(entry);
  }

  // VS Code: only its user-level `mcp.json` is importable (desktop-side), so
  // availability is keyed on that file rather than a config directory.
  {
    const candidates = [
      path.join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json"),
      path.join(homeDir, ".config", "Code", "User", "mcp.json"),
    ];
    let available = false;
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        available = true;
        break;
      }
    }
    const entry: LocalImportScanSource = { source: "vscode", available, parts: {} };
    if (available) entry.parts.mcp = { handledBy: "desktop" };
    sources.push(entry);
  }

  return { homeDir, sources };
}

// ---------------------------------------------------------------------------
// Conversation listing (for the per-session picker)
// ---------------------------------------------------------------------------

async function existingConversationIds(userId: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    if (chunk.length === 0) continue;
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, userId), inArray(conversations.id, chunk)));
    for (const row of rows) found.add(row.id);
  }
  return found;
}

async function fileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return Date.now();
  }
}

export async function listLocalConversations(
  userId: string,
  source: LocalImportServerSource,
  options?: LocalImportOptions,
): Promise<LocalImportConversationListResult> {
  const homeDir = await resolveHome(options);
  const summaries: LocalImportConversationSummary[] = [];

  if (source === "claude-code") {
    for (const file of await listClaudeSessionFiles(homeDir)) {
      const head = await readClaudeHead(file.filePath);
      if (!isClaudeHeadImportable(head)) continue;
      const mtime = await fileMtimeMs(file.filePath);
      summaries.push({
        id: file.id,
        title: truncateTitle(head.aiTitle || head.firstUserText),
        cwd: head.cwd,
        createdAt: head.firstTimestamp ?? mtime,
        updatedAt: mtime,
        sizeBytes: file.sizeBytes,
        alreadyImported: false,
      });
    }
  } else if (source === "codex") {
    const index = await readCodexIndex(homeDir);
    for (const file of await listCodexRolloutFiles(homeDir)) {
      const head = await readCodexHead(file.filePath);
      if (!head.meta || isCodexSkippedMeta(head.meta) || !head.firstUserText) continue;
      const id = head.meta.id ?? file.id;
      const row = index.get(id);
      const mtime = await fileMtimeMs(file.filePath);
      summaries.push({
        id,
        title: truncateTitle(row?.title || head.firstUserText),
        cwd: head.meta.cwd ?? row?.cwd ?? null,
        createdAt: head.meta.timestamp ?? row?.createdAt ?? mtime,
        updatedAt: row?.updatedAt ?? mtime,
        sizeBytes: file.sizeBytes,
        alreadyImported: false,
      });
    }
  }

  const existing = await existingConversationIds(
    userId,
    summaries.map((s) => s.id),
  );
  for (const s of summaries) s.alreadyImported = existing.has(s.id);
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { source, conversations: summaries };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function ftsInsert(messageId: string, conversationId: string, content: string) {
  try {
    await client.execute({
      sql: `INSERT INTO messages_fts(message_id, conversation_id, content) VALUES (?, ?, ?)`,
      args: [messageId, conversationId, content.substring(0, 5000)],
    });
  } catch {
    // FTS table may not exist (pre-migration DB); search just won't see the row.
  }
}

async function ftsDeleteMessages(messageIds: string[]) {
  for (const messageId of messageIds) {
    try {
      await client.execute({
        sql: `DELETE FROM messages_fts WHERE message_id = ?`,
        args: [messageId],
      });
    } catch {
      // best-effort
    }
  }
}

/** Seconds-precision storage + `ORDER BY created_at` reads: keep every message strictly later than the previous one. */
function monotonicTimestamps(list: ParsedMessage[]): Date[] {
  const out: Date[] = [];
  let lastSec = Number.NEGATIVE_INFINITY;
  for (const m of list) {
    let sec = Math.floor(m.createdAt / 1000);
    if (sec <= lastSec) sec = lastSec + 1;
    lastSec = sec;
    out.push(new Date(sec * 1000));
  }
  return out;
}

type PersistOutcome = "imported" | "updated" | "unchanged";

async function persistSession(
  userId: string,
  source: ImportSource,
  session: ParsedSession,
  projectIdByRoot: Map<string, string>,
  now: Date,
): Promise<PersistOutcome> {
  const projectId = session.cwd ? (projectIdByRoot.get(session.cwd) ?? null) : null;
  const existing = await db
    .select({
      id: conversations.id,
      updatedAt: conversations.updatedAt,
      importedAt: conversations.importedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.id, session.id), eq(conversations.userId, userId)))
    .limit(1);

  const sourceUpdatedAt = new Date(Math.floor(session.updatedAt / 1000) * 1000);
  const createdAt = new Date(Math.floor(session.createdAt / 1000) * 1000);

  let outcome: PersistOutcome;
  if (existing.length > 0) {
    // Seconds precision on both sides; anything not strictly newer is unchanged.
    if (sourceUpdatedAt.getTime() <= existing[0].updatedAt.getTime()) return "unchanged";
    // Only replace what the previous import wrote. Turns the user added inside
    // OpenHorn after importing have createdAt > importedAt and must survive.
    // A same-id conversation that was never imported is not ours to touch.
    const previousImportedAt = existing[0].importedAt;
    if (!previousImportedAt) return "unchanged";
    const stale = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, session.id), lte(messages.createdAt, previousImportedAt)),
      );
    const staleIds = stale.map((row) => row.id);
    if (staleIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, staleIds));
      await ftsDeleteMessages(staleIds);
    }
    await db
      .update(conversations)
      .set({
        title: session.title,
        modelId: session.model,
        projectId,
        updatedAt: sourceUpdatedAt,
        importedFrom: source,
        importedAt: now,
      })
      .where(eq(conversations.id, session.id));
    outcome = "updated";
  } else {
    await db.insert(conversations).values({
      id: session.id,
      userId,
      title: session.title,
      modelId: session.model,
      contextLength: 4096,
      defaultMode: "agent",
      lastMode: "agent",
      isPinned: false,
      projectId,
      importedFrom: source,
      importedAt: now,
      createdAt,
      updatedAt: sourceUpdatedAt,
    });
    outcome = "imported";
  }

  const stamps = monotonicTimestamps(session.messages);
  for (let i = 0; i < session.messages.length; i++) {
    const m = session.messages[i];
    const id = generateId();
    await db.insert(messages).values({
      id,
      conversationId: session.id,
      role: m.role,
      content: m.content,
      model: m.model,
      mode: "agent",
      usage: m.usage ? JSON.stringify(m.usage) : null,
      createdAt: stamps[i],
    });
    await ftsInsert(id, session.id, m.content);
  }
  return outcome;
}

async function loadProjectIndex(userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: projects.id, rootPath: projects.rootPath })
    .from(projects)
    .where(eq(projects.userId, userId));
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.rootPath, row.id);
    map.set(row.rootPath.replace(/\/+$/, ""), row.id);
  }
  return map;
}

/**
 * Imports the selected sessions. Messages are not a part of their own: the
 * count goes into each item's detail and the part note, so `totalImported`
 * counts conversations only.
 */
async function importConversations(
  userId: string,
  source: LocalImportServerSource,
  homeDir: string,
  selection: string[] | "all",
  errors: string[],
): Promise<ImportPart> {
  const convPart = createPart("conversations");
  if (source === "gemini") return convPart;

  const files =
    source === "claude-code"
      ? await listClaudeSessionFiles(homeDir)
      : await listCodexRolloutFiles(homeDir);
  const codexIndex =
    source === "codex" ? await readCodexIndex(homeDir) : new Map<string, CodexIndexRow>();

  let wanted: SessionFile[];
  if (selection === "all") {
    wanted = files;
  } else {
    const ids = new Set(selection.map((s) => s.toLowerCase()));
    // Codex ids come from session_meta and normally equal the file uuid; match on the file id first.
    wanted = files.filter((f) => ids.has(f.id));
  }
  if (wanted.length > LOCAL_IMPORT_RUN_MAX_CONVERSATIONS) {
    errors.push(
      `conversations: ${wanted.length} requested, only the first ${LOCAL_IMPORT_RUN_MAX_CONVERSATIONS} processed`,
    );
    wanted = wanted.slice(0, LOCAL_IMPORT_RUN_MAX_CONVERSATIONS);
  }

  const projectIndex = await loadProjectIndex(userId);
  const now = new Date();
  let messageCount = 0;

  for (const file of wanted) {
    try {
      const session =
        source === "claude-code"
          ? await parseClaudeSession(file)
          : await parseCodexSession(file, codexIndex.get(file.id));
      if (!session) {
        addPartItem(convPart, {
          label: file.id,
          detail: IMPORT_DETAIL.noImportableMessages,
          status: "skipped",
        });
        continue;
      }
      const outcome = await persistSession(userId, source, session, projectIndex, now);
      if (outcome === "unchanged") {
        addPartItem(convPart, {
          label: session.title,
          detail: IMPORT_DETAIL.unchanged,
          status: "skipped",
          link: { kind: "conversation", id: session.id },
        });
        continue;
      }
      messageCount += session.messages.length;
      const detailBits = [
        ...(outcome === "updated" ? [IMPORT_DETAIL.updated] : []),
        IMPORT_DETAIL.messageCount(session.messages.length),
        ...(session.cwd ? [session.cwd] : []),
      ];
      addPartItem(convPart, {
        label: session.title,
        detail: detailBits.join(" · "),
        status: "imported",
        link: { kind: "conversation", id: session.id },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`conversation ${file.id}: ${message}`);
      addPartItem(convPart, { label: file.id, detail: message, status: "skipped" });
    }
  }
  if (messageCount > 0) convPart.note = IMPORT_DETAIL.messagesNote(messageCount);
  return convPart;
}

async function importInstructions(
  userId: string,
  source: LocalImportServerSource,
  homeDir: string,
  errors: string[],
): Promise<ImportPart> {
  const part = createPart("instructions");
  const filePath = instructionsPath(homeDir, source);
  const basename = path.basename(filePath);
  const real = await safeRealPath(homeDir, filePath);
  if (!real) {
    addPartItem(part, { label: basename, detail: IMPORT_DETAIL.fileNotFound, status: "skipped" });
    return part;
  }
  try {
    const text = (await readFile(real, "utf8")).trim();
    if (!text) {
      addPartItem(part, { label: basename, detail: IMPORT_DETAIL.fileEmpty, status: "skipped" });
      return part;
    }
    const current = await getSettingValues(userId, [GLOBAL_SYSTEM_PROMPT_SETTING_KEY]);
    const marker = instructionsMarker(source, basename);
    const merged = mergeInstructions(current[GLOBAL_SYSTEM_PROMPT_SETTING_KEY], marker, text);
    await setSettingValue(userId, GLOBAL_SYSTEM_PROMPT_SETTING_KEY, merged.value);
    addPartItem(part, {
      label: basename,
      detail: merged.replaced
        ? IMPORT_DETAIL.instructionsReplaced
        : IMPORT_DETAIL.instructionsAppended,
      status: "imported",
      link: { kind: "settings-tab", id: "general" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`instructions ${basename}: ${message}`);
    addPartItem(part, { label: basename, detail: message, status: "skipped" });
  }
  return part;
}

async function importPrompts(
  userId: string,
  source: LocalImportServerSource,
  homeDir: string,
  errors: string[],
): Promise<ImportPart> {
  const part = createPart("prompts");
  const files = await listPromptFiles(homeDir, source);
  if (files.length === 0) return part;

  const current = await getSettingValues(userId, [PROMPT_TEMPLATES_SETTING_KEY]);
  const templates = parsePromptTemplates(current[PROMPT_TEMPLATES_SETTING_KEY]);
  const byKey = new Map(templates.map((t) => [promptTemplateKey(t), t] as const));
  const now = Date.now();
  let changed = false;

  for (const file of files) {
    const display = file.namespace ? `${file.namespace}:${file.name}` : file.name;
    try {
      const parsed = parsePromptFile(await readFile(file.filePath, "utf8"));
      if (!parsed.body) {
        addPartItem(part, {
          label: display,
          detail: IMPORT_DETAIL.promptEmptyBody,
          status: "skipped",
        });
        continue;
      }
      const key = promptTemplateKey({ source, name: file.name, namespace: file.namespace });
      const previous = byKey.get(key);
      const template: PromptTemplate = {
        id: previous?.id ?? generateId(),
        name: file.name,
        ...(file.namespace ? { namespace: file.namespace } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
        body: parsed.body,
        source,
        importedAt: now,
      };
      byKey.set(key, template);
      changed = true;
      const detailBits = [
        ...(previous ? [IMPORT_DETAIL.promptUpdated] : []),
        ...(parsed.description ? [parsed.description] : []),
      ];
      addPartItem(part, {
        label: display,
        ...(detailBits.length ? { detail: detailBits.join(" · ") } : {}),
        status: "imported",
        link: { kind: "prompt", id: template.id },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`prompt ${display}: ${message}`);
      addPartItem(part, { label: display, detail: message, status: "skipped" });
    }
  }

  if (changed) {
    await setSettingValue(
      userId,
      PROMPT_TEMPLATES_SETTING_KEY,
      JSON.stringify(Array.from(byKey.values())),
    );
  }
  return part;
}

export async function runLocalImport(
  userId: string,
  request: LocalImportRunRequest,
  options?: LocalImportOptions,
): Promise<LocalImportRunResult> {
  const homeDir = await resolveHome(options);
  const errors: string[] = [];
  const parts: ImportPart[] = [];

  if (request.parts.conversations) {
    parts.push(
      await importConversations(
        userId,
        request.source,
        homeDir,
        request.parts.conversations.sessionIds,
        errors,
      ),
    );
  }
  if (request.parts.instructions) {
    parts.push(await importInstructions(userId, request.source, homeDir, errors));
  }
  if (request.parts.prompts) {
    parts.push(await importPrompts(userId, request.source, homeDir, errors));
  }

  const record = await createImportRecord(userId, {
    source: request.source,
    kind: "local",
    parts,
    errors,
  });
  return { recordId: record.id, parts, errors };
}
