/**
 * DeepSeek v3 archive validation/conversion, independent of SQL and HTTP.
 * Format/schema are adapted from the MIT chat-demo sources alongside this file.
 * Branch and refusal semantics follow history/toLocal.ts at commit
 * 5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c; OpenHorn imports only the current path.
 */
import { createHash } from "node:crypto";
import type { MessageFinishReason } from "shared/types";
import type { ChatMessage, FileEntry, SessionFile } from "./deepseekImportFormat";
import { checkManifest, readSessionFile, readSessionIndex } from "./deepseekImportSchema";
import type { ImportStep } from "./importTurnBuilder";

export interface DeepSeekAttachment {
  source: FileEntry;
  data?: Buffer;
  mime?: string;
  unavailableReason?: "missing" | "unsupported";
}

export interface DeepSeekMessage {
  sourceId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  finishReason: MessageFinishReason | null;
  steps: ImportStep[];
  attachments: DeepSeekAttachment[];
}

export interface DeepSeekConversation {
  sourceId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  isPinned: boolean;
  messages: DeepSeekMessage[];
  warnings: string[];
}

export function isDeepSeekManifest(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || "formatVersion" in value) return false;
    checkManifest(value);
    return true;
  } catch {
    return false;
  }
}

/** The existing conversation PK is the durable, per-user source identity. */
export function deepseekConversationId(userId: string, sourceId: string): string {
  return `deepseek-${createHash("sha256")
    .update(JSON.stringify(["deepseek", userId, sourceId]))
    .digest("hex")}`;
}

function invalid(section: string): never {
  throw new Error(`Invalid DeepSeek archive: ${section}`);
}

function json(entries: Map<string, Buffer>, name: string): unknown {
  const bytes = entries.get(name);
  if (!bytes) return invalid(`missing ${name}`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid(`JSON ${name}`);
  }
}

function safePath(name: string): boolean {
  return (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: archive names must reject NUL/control characters
    !/[\\\x00-\x1f]/.test(name) &&
    !name.startsWith("/") &&
    name.split("/").every((part) => part !== "." && part !== ".." && part !== "")
  );
}

function webUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function imageMime(data: Buffer): string | undefined {
  const header = data.subarray(0, 12).toString("ascii");
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return "image/webp";
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("BM")) return "image/bmp";
  if (header.slice(4, 8) === "ftyp" && ["avif", "avis"].includes(header.slice(8)))
    return "image/avif";
  return undefined;
}

/** Validate every node, including unselected branches, before following the cursor. */
function currentBranch(file: SessionFile): ChatMessage[] {
  const byId = new Map<number, ChatMessage>();
  for (const message of [...file.messages].sort((a, b) => a.id - b.id)) {
    const parent = message.parent_id === null ? null : byId.get(message.parent_id);
    if (
      byId.has(message.id) ||
      (message.parent_id === null
        ? message.role !== "USER"
        : !parent || parent.role === message.role || parent.id >= message.id)
    ) {
      invalid(`message branches (${file.id})`);
    }
    byId.set(message.id, message);
  }
  if (file.messages.length === 0) return [];
  const branch: ChatMessage[] = [];
  let current = byId.get(file.current_message_id);
  if (!current) invalid(`current message (${file.id})`);
  while (current) {
    branch.push(current);
    current = current.parent_id === null ? undefined : byId.get(current.parent_id);
  }
  return branch.reverse();
}

function convertMessage(
  message: ChatMessage,
  files: Map<FileEntry, DeepSeekAttachment>,
  warnings: Set<string>,
): DeepSeekMessage {
  const steps: ImportStep[] = [];
  const text: string[] = [];
  const attachments: DeepSeekAttachment[] = [];
  const refused = message.status === "CONTENT_FILTER";
  const tool = (
    index: number,
    name: string,
    input: unknown,
    output: unknown,
    status = "FINISHED",
  ) => {
    const toolCallId = `deepseek-history-${message.id}-${index}`;
    steps.push({ type: "tool_start", toolName: name, toolInput: input, toolCallId });
    if (status === "WIP") {
      warnings.add(`DeepSeek message ${message.id}: unfinished ${name} step`);
    } else {
      steps.push({
        type: status === "FAILED" ? "error" : "tool_result",
        toolName: name,
        toolCallId,
        content: JSON.stringify(output),
      });
    }
  };
  for (const [index, fragment] of message.fragments.entries()) {
    if (message.role === "USER" && fragment.type !== "REQUEST" && fragment.type !== "FILE") {
      invalid("non-request fragment on user message");
    }
    switch (fragment.type) {
      case "REQUEST":
        if (message.role !== "USER") invalid("assistant REQUEST fragment");
        text.push(fragment.content);
        break;
      case "RESPONSE":
        if (message.role !== "ASSISTANT") invalid("user RESPONSE fragment");
        if (!refused) text.push(fragment.content);
        break;
      case "THINK":
        if (message.role !== "ASSISTANT") invalid("user THINK fragment");
        if (!refused) steps.push({ type: "thinking", content: fragment.content });
        break;
      case "FILE":
        for (const file of fragment.files) {
          const prepared = files.get(file);
          if (!prepared) invalid("unprepared attachment");
          attachments.push(prepared);
        }
        break;
      case "TOOL_SEARCH": {
        const results = fragment.results.filter((result) => webUrl(result.url));
        if (results.length !== fragment.results.length)
          warnings.add(`DeepSeek message ${message.id}: unsafe search URLs omitted`);
        tool(
          index,
          "deepseek_web_search",
          { queries: fragment.queries },
          { status: fragment.status ?? "FINISHED", results },
          fragment.status,
        );
        break;
      }
      case "TOOL_OPEN":
        if (fragment.url && webUrl(fragment.url)) {
          tool(
            index,
            "deepseek_read_url",
            { url: fragment.url },
            {
              status: fragment.status,
              url: fragment.url,
              title: fragment.title,
              snippet: fragment.snippet ?? null,
              published_at: fragment.published_at,
            },
            fragment.status,
          );
        } else warnings.add(`DeepSeek message ${message.id}: page metadata unavailable`);
        break;
      case "TOOL_FIND":
        tool(
          index,
          "deepseek_find_in_page",
          { pattern: fragment.pattern ?? "" },
          { status: fragment.status },
          fragment.status,
        );
        break;
      case "READ_LINK": {
        // Signatures are opaque provider state, never replay them as OpenHorn credentials/context.
        const results = fragment.results
          .filter((result) => result.url && webUrl(result.url))
          .map((result) => ({ url: result.url, title: result.title ?? null }));
        if (results.length)
          steps.push({ type: "reasoning", content: JSON.stringify({ readLinks: results }) });
        warnings.add(
          `DeepSeek message ${message.id}: read-link signatures and fetched bodies cannot be restored`,
        );
        break;
      }
      case "TEMPLATE_RESPONSE":
      case "TIP":
      case "CONTENT_RISK":
        steps.push({ type: "error", content: fragment.content });
        warnings.add(`DeepSeek message ${message.id}: ${fragment.type} retained as a notice`);
        break;
      default:
        warnings.add(`DeepSeek message ${message.id}: unsupported ${fragment.type} fragment`);
    }
  }
  let finishReason: MessageFinishReason | null = null;
  if (message.role === "ASSISTANT") {
    if (refused) finishReason = "refused";
    else if (["WIP", "INCOMPLETE"].includes(message.status)) finishReason = "stopped";
    else if (message.status !== "FINISHED") finishReason = "error";
    if (message.fragments.some((f) => f.type === "TEMPLATE_RESPONSE") && !finishReason)
      finishReason = "error";
    if (finishReason) warnings.add(`DeepSeek message ${message.id}: ${message.status}`);
  }
  return {
    sourceId: message.id,
    role: message.role === "USER" ? "user" : "assistant",
    content: text.join(""),
    createdAt: new Date(message.inserted_at),
    finishReason,
    steps,
    attachments,
  };
}

/** All JSON, identities, branches and file references are checked before returning. */
export function prepareDeepSeekArchive(rawEntries: Map<string, Buffer>): DeepSeekConversation[] {
  const entries = new Map<string, Buffer>();
  for (const [rawName, bytes] of rawEntries) {
    const name = rawName.normalize("NFC");
    if (!safePath(name) || entries.has(name)) invalid("duplicate or unsafe entry path");
    entries.set(name, bytes);
  }
  if (!isDeepSeekManifest(json(entries, "manifest.json"))) invalid("manifest");
  const index = readSessionIndex(json(entries, "chat_session_index.json"));
  const listed = new Set(index.map((row) => row.id));
  if (listed.size !== index.length) invalid("duplicate session index");
  for (const name of entries.keys()) {
    if (["manifest.json", "chat_session_index.json", "user.json"].includes(name)) continue;
    const session = /^chat_sessions\/([^/]+)\.json$/.exec(name);
    const image = /^chat_sessions\/([^/]+)_files\/[^/]+$/.exec(name);
    if (!(session && listed.has(session[1])) && !(image && listed.has(image[1])))
      invalid("unlisted session or entry");
  }
  return index.map((entry) => {
    const file = readSessionFile(json(entries, `chat_sessions/${entry.id}.json`));
    if (
      file.id !== entry.id ||
      file.messages.length !== entry.message_count ||
      file.title !== entry.title ||
      file.inserted_at !== entry.inserted_at ||
      file.updated_at !== entry.updated_at
    )
      invalid("session index mismatch");
    const branch = currentBranch(file);
    const warnings = new Set<string>();
    if (branch.length !== file.messages.length)
      warnings.add(
        `DeepSeek ${file.id}: ${file.messages.length - branch.length} messages outside the current branch were not imported`,
      );
    const files = new Map<FileEntry, DeepSeekAttachment>();
    const pathOwners = new Map<string, string>();
    for (const message of file.messages) {
      for (const fragment of message.fragments) {
        if (fragment.type !== "FILE") continue;
        for (const source of fragment.files) {
          const name = source.export_path?.normalize("NFC");
          if (
            name !== undefined &&
            (!name ||
              !source.is_image ||
              !safePath(name) ||
              !name.startsWith(`chat_sessions/${file.id}_files/`) ||
              (pathOwners.has(name) && pathOwners.get(name) !== source.id))
          )
            invalid("attachment reference");
          if (name) pathOwners.set(name, source.id);
          const data = name ? entries.get(name) : undefined;
          if (data && data.length !== source.file_size) invalid("attachment size");
          const mime = data && imageMime(data);
          files.set(source, {
            source,
            ...(data && mime && data.length <= 20 * 1024 * 1024
              ? { data, mime }
              : { unavailableReason: data ? ("unsupported" as const) : ("missing" as const) }),
          });
        }
      }
      // Even off-branch content must be valid; never import a good prefix of a bad archive.
      convertMessage(message, files, new Set());
    }
    return {
      sourceId: file.id,
      title: file.title ?? "DeepSeek",
      isPinned: file.pinned,
      createdAt: new Date(file.inserted_at),
      updatedAt: new Date(file.updated_at),
      messages: branch.map((message) => convertMessage(message, files, warnings)),
      warnings: [...warnings],
    };
  });
}
