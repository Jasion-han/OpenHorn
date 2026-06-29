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

import type { SidecarEndpoint } from "./sidecarClient";
import type { SidecarPlatform } from "../stores/sidecarStore";

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
