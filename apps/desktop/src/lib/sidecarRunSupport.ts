import { useChatStore } from "../stores/chatStore";
import type { AgentTaskStreamEvent } from "./agentTaskStream";
import { normalizeMcpServerConfig } from "./mcpServerConfig";
import type { ServerApi } from "./serverApi";
import { discoverSkills, skillsDisabledList } from "./tauriBridge";

/**
 * Pieces of a sidecar agent turn that are independent of *who* starts it. The
 * composer (`useSidecarAgentRun`) and the scheduled-task runner both build a
 * run from these, so a scheduled run is the same turn a typed message would
 * be: same skills, same MCP roster, same event → chatStore projection.
 */

/** Skill metadata sent with a run — read in place from `path` (Claude-style). */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/**
 * Resolve the user's enabled skills to send with a run. Skills are discovered
 * as real folders across the known locations (cc-switch, Claude Code, Codex,
 * Gemini) minus the user-disabled set, and read IN PLACE — the run carries each
 * skill's name/description + absolute folder path; nothing is copied.
 */
export async function resolveEnabledSkills(): Promise<SkillMeta[]> {
  const [discovered, disabled] = await Promise.all([discoverSkills(), skillsDisabledList()]);
  const disabledSet = new Set(disabled.map((n) => n.trim().toLowerCase()));
  return (discovered ?? [])
    .filter((s) => !disabledSet.has(s.name.trim().toLowerCase()))
    .map((s) => ({
      name: s.name,
      description: (s.description ?? "").replace(/\s+/g, " ").trim(),
      path: s.path,
    }));
}

/**
 * Enabled MCP servers reshaped into the SDK's format (keyed by name) with the
 * transport type normalized to stdio/sse/http — see normalizeMcpServerConfig.
 * `targetMcpServer` (a `/server` slash invocation) narrows the roster to that
 * single server; if the name no longer matches an enabled server the full
 * roster is kept rather than silently dropping MCP. Undefined when none.
 */
export async function resolveEnabledMcpServers(
  api: ServerApi,
  targetMcpServer?: string,
): Promise<Record<string, Record<string, unknown>> | undefined> {
  const { servers } = await api.mcp.listServers();
  const map: Record<string, Record<string, unknown>> = {};
  for (const server of (servers || []) as Array<{
    name: string;
    type: string;
    config: Record<string, unknown> | null;
    isEnabled: boolean;
  }>) {
    if (!server.isEnabled) continue;
    map[server.name] = normalizeMcpServerConfig(server.type, server.config);
  }
  let mcpServers = Object.keys(map).length > 0 ? map : undefined;
  const target = targetMcpServer?.trim().toLowerCase();
  if (mcpServers && target) {
    const hit = Object.entries(mcpServers).find(([name]) => name.toLowerCase() === target);
    if (hit) mcpServers = { [hit[0]]: hit[1] };
  }
  return mcpServers;
}

const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";

/**
 * Per-run settings every sidecar turn carries: the global system prompt plus
 * the Tavily key when live search is requested (and not disabled). One resolver
 * for the send / retry / edit / scheduled paths so they cannot drift.
 */
export async function resolveRunSettings(
  api: ServerApi,
  forceWebSearch: boolean,
): Promise<{ systemPrompt: string | undefined; tavilyApiKey: string | undefined }> {
  let systemPrompt: string | undefined;
  try {
    const { settings } = await api.settings.get([GLOBAL_SYSTEM_PROMPT_KEY]);
    systemPrompt = settings[GLOBAL_SYSTEM_PROMPT_KEY] || undefined;
  } catch {
    systemPrompt = undefined;
  }
  let tavilyApiKey: string | undefined;
  if (forceWebSearch) {
    try {
      const { settings } = await api.settings.get([
        "liveSearch.tavilyApiKey",
        "liveSearch.tavilyEnabled",
      ]);
      if (settings["liveSearch.tavilyEnabled"] !== "false") {
        tavilyApiKey = settings["liveSearch.tavilyApiKey"] || undefined;
      }
    } catch {
      // ignore
    }
  }
  return { systemPrompt, tavilyApiKey };
}

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A model option dynamically provided by an ACP agent session. */
export interface AcpAvailableModel {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the caller still has to react to after an event was projected into the
 * chat store. Everything visible (text, tool steps, failure state) is already
 * applied; these carry the side data the store does not own.
 */
export type SidecarEventOutcome =
  | { kind: "handled" }
  | { kind: "usage"; usage: RunUsage }
  | { kind: "acp_models"; models: AcpAvailableModel[] }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Projects one sidecar stream event onto the assistant message through
 * chatStore.applyStreamEvent — the same interface the server runtime uses, and
 * the same projection whether the message is on screen or in the background
 * cache. Returns what the caller must still handle (usage capture, ACP model
 * list, run end).
 */
export function applySidecarEventToChat(
  assistantMessageId: string,
  event: AgentTaskStreamEvent,
): SidecarEventOutcome {
  const store = useChatStore.getState();
  if (event.type === "execution_event" && event.eventType === "final_text" && event.content) {
    store.applyStreamEvent(assistantMessageId, { type: "delta", content: event.content });
    return { kind: "handled" };
  }
  if (event.type === "execution_event" && event.eventType === "text" && event.content) {
    store.applyStreamEvent(assistantMessageId, { type: "delta", content: event.content });
    return { kind: "handled" };
  }
  // ACP dynamic model list — surfaced to the caller so the model picker can
  // show agent-provided models instead of the static channel list.
  if (event.type === "execution_event" && event.eventType === "available_models") {
    const meta = event.metadata as { models?: AcpAvailableModel[] } | undefined;
    if (Array.isArray(meta?.models)) {
      return { kind: "acp_models", models: meta.models };
    }
    return { kind: "handled" };
  }
  // Held for persistence rather than rendered: the bubble shows the token
  // count only after the row is saved, from the stored value.
  if (event.type === "execution_event" && event.eventType === "usage") {
    const meta = event.metadata as Record<string, unknown> | undefined;
    if (!meta) return { kind: "handled" };
    const usage: RunUsage = {
      promptTokens: Number(meta.promptTokens) || 0,
      completionTokens: Number(meta.completionTokens) || 0,
      totalTokens: Number(meta.totalTokens) || 0,
    };
    // ACP usage_update carries context window size and cost — surface them as
    // a context_usage agent event so the run panel can show a live occupancy bar.
    if (meta.contextSize || meta.cost) {
      store.applyStreamEvent(assistantMessageId, {
        type: "agent_event",
        event: {
          type: "context_usage",
          toolInput: {
            used: Number(meta.promptTokens) || 0,
            size: Number(meta.contextSize) || 0,
            cost: meta.cost,
          },
        },
      });
    }
    return { kind: "usage", usage };
  }
  if (
    event.type === "execution_event" &&
    event.eventType !== "final_text" &&
    event.eventType !== "text"
  ) {
    // For ACP-specific event types (tool_call_detail, plan, agent_info), the
    // data lives in metadata rather than toolInput — pass it through as
    // toolInput so applyAgentEventToRun can read it uniformly.
    const useMetadata =
      event.eventType === "tool_call_detail" ||
      event.eventType === "plan" ||
      event.eventType === "agent_info";
    store.applyStreamEvent(assistantMessageId, {
      type: "agent_event",
      event: {
        type: event.eventType ?? "",
        content: event.content,
        toolName: event.toolName,
        toolInput: useMetadata ? event.metadata : event.toolInput,
      },
    });
    return { kind: "handled" };
  }
  if (event.type === "done") {
    store.applyStreamEvent(assistantMessageId, { type: "done", messageId: assistantMessageId });
    return { kind: "done" };
  }
  if (event.type === "error") {
    const message = event.content || "本地运行出错";
    store.applyStreamEvent(assistantMessageId, { type: "error", message });
    return { kind: "error", message };
  }
  return { kind: "handled" };
}
