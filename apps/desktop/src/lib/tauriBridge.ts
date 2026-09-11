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
 * True when the window uses the macOS overlay title bar (see the window builder
 * in src-tauri): the webview reaches the top of the window, so the frontend owns
 * both the drag behaviour and keeping the traffic-light corner clear.
 */
export function hasOverlayTitleBar(): boolean {
  if (!isTauriRuntime() || typeof navigator === "undefined") return false;
  return /Mac/i.test(navigator.platform);
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
 * Opens a native file picker filtered for data import files (ZIP / JSON).
 * Returns the absolute path of the chosen file, or null when the user cancels.
 * Outside Tauri returns null.
 */
export async function pickImportFile(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("pick_import_file")) as string | null;
}

/**
 * Opens a native folder picker for choosing an export output directory.
 * Reuses the existing `pick_workspace_dir` Tauri command.
 * Returns the absolute path or null when the user cancels.
 */
export async function pickExportDir(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("pick_workspace_dir")) as string | null;
}

/** One editor bundle found on this machine by `external_editors_detect`. */
export interface DetectedEditor {
  id: string;
  name: string;
  appPath: string;
  /** Whether the Rust side knows how to pass a line number to this editor. */
  supportsLine: boolean;
}

/** The editor to launch a workspace file with; `id` selects the line-number argv shape. */
export interface EditorChoice {
  id?: string;
  appPath: string;
}

/**
 * Lists the known editors installed in /Applications or ~/Applications.
 * Outside Tauri returns an empty list.
 */
export async function externalEditorsDetect(): Promise<DetectedEditor[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("external_editors_detect")) as DetectedEditor[];
}

/**
 * Opens a workspace file with the chosen editor (jumping to `line` when the
 * editor supports it) or, without `editor`, the OS default application.
 * `path` may be relative to `workspaceRoot` or absolute; the Rust side
 * refuses anything that does not resolve to a regular file under the root.
 * Goes through a dedicated command because the shell plugin's scope does not
 * allow `file://`, and widening it would let the webview open anything.
 * Rejects with the Rust error message, or when not running under Tauri.
 */
export async function openWorkspaceFile(
  workspaceRoot: string,
  path: string,
  opts?: { line?: number; editor?: EditorChoice | null },
): Promise<void> {
  if (!isTauriRuntime()) throw new Error("open_workspace_file is only available in Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("open_workspace_file", {
    workspaceRoot,
    path,
    line: opts?.line ?? null,
    editor: opts?.editor ? { id: opts.editor.id ?? null, appPath: opts.editor.appPath } : null,
  });
}

/** Reveals a workspace file in Finder / the file manager. Same path rules as `openWorkspaceFile`. */
export async function revealWorkspaceFile(workspaceRoot: string, path: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error("reveal_workspace_file is only available in Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("reveal_workspace_file", { workspaceRoot, path });
}

/**
 * Native picker for an application bundle (`.app`) to use as the editor.
 * Returns its absolute path, or null when cancelled / outside Tauri.
 */
export async function pickEditorApp(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("pick_editor_app")) as string | null;
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

// ---------------------------------------------------------------------------
// Preview panel: embedded browser backed by a Tauri child webview
// ---------------------------------------------------------------------------

export interface PreviewWebviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewWebviewPageLoadEvent {
  label: string;
  url: string;
  phase: "started" | "finished";
}

export interface PreviewWebviewTitleEvent {
  label: string;
  title: string;
}

export interface PreviewWebviewHistoryState {
  canGoBack: boolean;
  canGoForward: boolean;
}

function roundRect(rect: PreviewWebviewRect): PreviewWebviewRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

// Commands for one label run strictly in the order they were issued. The IPC
// transport is a series of independent fetches with no ordering guarantee, and
// React StrictMode issues open → close → open back to back on mount: if the
// close overtook the second open it would destroy the webview the component
// believes it owns. Serialising per label also means a set_visible / set_bounds
// issued while the open is still in flight lands after it instead of failing.
const previewCommandQueues = new Map<string, Promise<void>>();

function enqueuePreviewCommand(label: string, run: () => Promise<void>): Promise<void> {
  const previous = previewCommandQueues.get(label) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  const settled = next
    .catch(() => {})
    .then(() => {
      if (previewCommandQueues.get(label) === settled) previewCommandQueues.delete(label);
    });
  previewCommandQueues.set(label, settled);
  return next;
}

function enqueuePreviewQuery<T>(label: string, run: () => Promise<T>): Promise<T> {
  let result: T;
  return enqueuePreviewCommand(label, async () => {
    result = await run();
  }).then(() => result);
}

function invokePreviewCommand(
  label: string,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  // Enqueued synchronously (before the module import resolves) so the queue
  // order is the call order.
  return enqueuePreviewCommand(label, async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>(command, { label, ...args });
  });
}

/**
 * Creates (or re-points) the child webview `label` at `url`, positioned over
 * the given logical rect of the main webview. No-op outside Tauri.
 */
export function previewWebviewOpen(params: {
  label: string;
  url: string;
  rect: PreviewWebviewRect;
}): Promise<void> {
  return invokePreviewCommand(params.label, "preview_webview_open", {
    url: params.url,
    ...roundRect(params.rect),
  });
}

export function previewWebviewSetBounds(label: string, rect: PreviewWebviewRect): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_set_bounds", { ...roundRect(rect) });
}

export function previewWebviewNavigate(label: string, url: string): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_navigate", { url });
}

/** `delta` follows `history.go`: -1 back, 1 forward. */
export function previewWebviewHistory(label: string, delta: number): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_history", { delta });
}

/**
 * Native back/forward availability of the child webview. Queued behind any
 * pending navigation/history command for the same label so the answer reflects
 * the state after those were applied. Outside Tauri both are false.
 */
export function previewWebviewHistoryState(label: string): Promise<PreviewWebviewHistoryState> {
  if (!isTauriRuntime()) return Promise.resolve({ canGoBack: false, canGoForward: false });
  return enqueuePreviewQuery(label, async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const state = await invoke<PreviewWebviewHistoryState>("preview_webview_history_state", {
      label,
    });
    return { canGoBack: Boolean(state?.canGoBack), canGoForward: Boolean(state?.canGoForward) };
  });
}

/**
 * PNG data URL of the child webview's current frame, or `null` when it cannot
 * be taken (outside Tauri, webview gone, hidden, timed out). Never rejects:
 * callers use it opportunistically to paint a stand-in while the native view
 * is hidden, and a missing frame just means an empty stand-in.
 */
export function previewWebviewSnapshot(label: string): Promise<string | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  return enqueuePreviewQuery(label, async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const dataUrl = await invoke<string>("preview_webview_snapshot", { label });
    return typeof dataUrl === "string" && dataUrl.startsWith("data:image/") ? dataUrl : null;
  }).catch(() => null);
}

export function previewWebviewReload(label: string): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_reload", {});
}

export function previewWebviewSetVisible(label: string, visible: boolean): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_set_visible", { visible });
}

export function previewWebviewClose(label: string): Promise<void> {
  return invokePreviewCommand(label, "preview_webview_close", {});
}

type Unlisten = () => void;

/**
 * Subscribes to a Tauri event, resolving the unlisten function once the
 * listener is registered. Calling the returned function before registration
 * completes still unsubscribes (the pending listener is torn down on arrival).
 */
function subscribeTauriEvent<T>(name: string, cb: (payload: T) => void): Unlisten {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let unlisten: Unlisten | null = null;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<T>(name, (event) => cb(event.payload)))
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {});
  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

export function onPreviewWebviewPageLoad(
  cb: (event: PreviewWebviewPageLoadEvent) => void,
): Unlisten {
  return subscribeTauriEvent<PreviewWebviewPageLoadEvent>("preview-webview:page-load", cb);
}

export function onPreviewWebviewTitle(cb: (event: PreviewWebviewTitleEvent) => void): Unlisten {
  return subscribeTauriEvent<PreviewWebviewTitleEvent>("preview-webview:title", cb);
}
