/**
 * Thin wrapper around the Tauri IPC surface for the bits of the desktop
 * app that actually need it. When running under Vite dev (plain browser
 * at http://localhost:5173) there is no Tauri runtime, so these helpers
 * degrade to "unsupported" rather than throwing.
 *
 * The point of this file is to keep the rest of the desktop code
 * agnostic about whether Tauri is present. Components should call
 * `getTauriBridge()` and branch on the result — they do not import
 * `@tauri-apps/api/core` directly.
 */

import type { SidecarPlatform } from "../stores/sidecarStore";
import type { SidecarEndpoint } from "./sidecarClient";

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__);
}

export function isDesktopRuntime(): boolean {
  return isTauriRuntime();
}

/**
 * An MCP server discovered in (or parsed from) an existing client config on
 * the user's machine, already normalised into OpenHorn's shape.
 */
export interface DiscoveredMcpServer {
  client: string;
  /** Every platform this same tool was found in (for coverage tags). */
  clients: string[];
  name: string;
  type: string;
  config: Record<string, unknown>;
  description?: string;
  /** Tool-identity key; the same tool from several platforms shares it. */
  signature: string;
}

/**
 * Scans known MCP client config locations (Claude Desktop, Cursor, VS Code,
 * Codex CLI) and returns every server found. Returns [] outside Tauri.
 */
export async function discoverMcpConfigs(): Promise<DiscoveredMcpServer[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("mcp_discover_configs")) as DiscoveredMcpServer[];
}

/**
 * Opens a native file picker and parses the chosen MCP config file. Returns
 * null when the user cancels, [] when nothing parseable was found.
 */
export async function pickMcpConfigFile(): Promise<DiscoveredMcpServer[] | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("mcp_pick_config_file")) as DiscoveredMcpServer[] | null;
}

/**
 * A skill (a directory containing SKILL.md) discovered on the user's machine.
 */
export interface DiscoveredSkill {
  name: string;
  description?: string;
  /** Absolute path of the skill directory. */
  path: string;
  /** The client this row was first parsed from. */
  client: string;
  /** Every platform this same skill was found in (for coverage tags). */
  clients: string[];
}

/** A skill folder read into OpenHorn's create-skill shape. */
export interface ImportedSkill {
  name: string;
  description: string;
  content: string;
  files: Array<{ path: string; content: string; isBinary: boolean }>;
}

/**
 * Scans the known SKILL.md locations of common AI CLIs (Claude Code, Codex,
 * Gemini, cc-switch) and returns every skill found. Returns [] outside Tauri.
 */
export async function discoverSkills(): Promise<DiscoveredSkill[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skills_discover")) as DiscoveredSkill[];
}

/**
 * Reads a skill directory by absolute path into the create-skill shape
 * (SKILL.md frontmatter/body plus sibling resource files).
 */
export async function readSkillDir(path: string): Promise<ImportedSkill> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skill_read_dir", { path })) as ImportedSkill;
}

/**
 * Opens a native folder picker and reads the chosen skill directory. Returns
 * null when the user cancels.
 */
export async function pickSkillFolder(): Promise<ImportedSkill | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skill_pick_folder")) as ImportedSkill | null;
}

/** One file to write during skill materialization (rel path + content). */
export interface SkillMaterializeEntry {
  relPath: string;
  content: string;
  isBinary: boolean;
}

/**
 * Begin materializing enabled skills: creates a staging dir under the
 * workspace's `.openhorn/` and ensures `.openhorn/` is git-ignored. Returns the
 * staging dir path to stream batches into.
 */
export async function skillsMaterializeBegin(workspaceRoot: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skills_materialize_begin", { workspaceRoot })) as string;
}

/** Write one batch of files into the staging dir from `skillsMaterializeBegin`. */
export async function skillsMaterializeBatch(
  tmpRoot: string,
  entries: SkillMaterializeEntry[],
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("skills_materialize_batch", { tmpRoot, entries });
}

/**
 * Atomically swap the staging dir into place as `<root>/.openhorn/skills`.
 * Returns the final skills root passed to the sidecar run.
 */
export async function skillsMaterializeFinalize(
  workspaceRoot: string,
  tmpRoot: string,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skills_materialize_finalize", { workspaceRoot, tmpRoot })) as string;
}

/** Whether a previously-materialized skills dir still exists (cache validation). */
export async function skillsMaterializedExists(skillsRoot: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skills_materialized_exists", { skillsRoot })) as boolean;
}

/** Names of skills the user has explicitly disabled (everything else is on). */
export async function skillsDisabledList(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("skills_disabled_list")) as string[];
}

/** Enable/disable a discovered skill by name (persisted to a JSON file). */
export async function skillsSetEnabled(name: string, enabled: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("skills_set_enabled", { name, enabled });
}

/**
 * Returns a `SidecarPlatform` backed by the real Tauri IPC when we are
 * running inside the desktop shell. Returns `null` in every other
 * environment so the caller can `markUnsupported`.
 */
export async function getTauriSidecarPlatform(): Promise<SidecarPlatform | null> {
  if (!isTauriRuntime()) return null;

  // Dynamic import so Vite's dep optimizer doesn't try to resolve Tauri
  // modules at webpage load time in non-Tauri environments.
  const { invoke } = await import("@tauri-apps/api/core");

  return {
    startSidecar: async () => {
      return (await invoke("start_sidecar")) as SidecarEndpoint;
    },
    stopSidecar: async () => {
      await invoke("stop_sidecar");
    },
    pickWorkspaceDir: async () => {
      return (await invoke("pick_workspace_dir")) as string | null;
    },
  };
}
