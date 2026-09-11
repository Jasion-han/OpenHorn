import { create } from "zustand";
import { isTextLikePath } from "../lib/referenceLink";
import { type DetectedEditor, externalEditorsDetect, openWorkspaceFile } from "../lib/tauriBridge";

/**
 * Which editor "open in editor" launches for workspace files. The choice is
 * per machine (each machine has different editors installed), so it lives in
 * localStorage rather than server-side settings.
 */

export type ExternalEditorPreference =
  | { kind: "detected"; id: string }
  | { kind: "custom"; name: string; appPath: string }
  | null;

/** A concrete editor to launch: the preference resolved against what is installed. */
export interface ResolvedEditor {
  id?: string;
  name: string;
  appPath: string;
}

export const EXTERNAL_EDITOR_STORAGE_KEY = "openhorn.externalEditor";

export interface ExternalEditorState {
  preference: ExternalEditorPreference;
  detected: DetectedEditor[];
  detectStatus: "idle" | "loading" | "done";

  /** Runs editor detection once and caches the result; later calls are no-ops. */
  detect: () => Promise<DetectedEditor[]>;
  setPreference: (preference: ExternalEditorPreference) => void;
  /**
   * The editor to launch, or null when nothing is chosen. A "detected"
   * preference whose editor is no longer installed (or not detected yet)
   * also resolves to null and is treated as "not chosen".
   */
  resolveEditor: () => ResolvedEditor | null;
  /**
   * The "open externally" default action for a workspace file: text-like files
   * go to the preferred editor (with `line`) when one is chosen, everything
   * else — and text files without a preference — to the OS default app.
   * Returns false when the caller should ask the user to pick an editor
   * instead (text-like file, no usable preference).
   */
  openWithPreference: (workspaceRoot: string, path: string, line?: number) => Promise<boolean>;
}

/** Minimal storage surface so tests can inject an in-memory implementation. */
export interface EditorPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function defaultStorage(): EditorPreferenceStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Parses a persisted preference, dropping anything that is not one of the two shapes. */
export function parseEditorPreference(raw: string | null): ExternalEditorPreference {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.kind === "detected" && typeof record.id === "string" && record.id) {
      return { kind: "detected", id: record.id };
    }
    if (
      record.kind === "custom" &&
      typeof record.appPath === "string" &&
      record.appPath &&
      typeof record.name === "string"
    ) {
      return { kind: "custom", name: record.name, appPath: record.appPath };
    }
  } catch {}
  return null;
}

/** Display name for a custom `.app` path: the bundle file name without `.app`. */
export function editorNameFromAppPath(appPath: string): string {
  const trimmed = appPath.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return last.replace(/\.app$/i, "") || last;
}

export function createExternalEditorStore(options?: {
  storage?: EditorPreferenceStorage | null;
  detectEditors?: () => Promise<DetectedEditor[]>;
  openFile?: typeof openWorkspaceFile;
}) {
  const storage = options?.storage === undefined ? defaultStorage() : options.storage;
  const detectEditors = options?.detectEditors ?? externalEditorsDetect;
  const openFile = options?.openFile ?? openWorkspaceFile;
  let detectPromise: Promise<DetectedEditor[]> | null = null;

  const readPreference = (): ExternalEditorPreference => {
    try {
      return parseEditorPreference(storage?.getItem(EXTERNAL_EDITOR_STORAGE_KEY) ?? null);
    } catch {
      return null;
    }
  };

  const writePreference = (preference: ExternalEditorPreference) => {
    try {
      if (preference === null) storage?.removeItem(EXTERNAL_EDITOR_STORAGE_KEY);
      else storage?.setItem(EXTERNAL_EDITOR_STORAGE_KEY, JSON.stringify(preference));
    } catch {}
  };

  return create<ExternalEditorState>()((set, get) => ({
    preference: readPreference(),
    detected: [],
    detectStatus: "idle",

    detect: () => {
      if (detectPromise) return detectPromise;
      set({ detectStatus: "loading" });
      detectPromise = detectEditors()
        .catch(() => [] as DetectedEditor[])
        .then((detected) => {
          set({ detected, detectStatus: "done" });
          return detected;
        });
      return detectPromise;
    },

    setPreference: (preference) => {
      set({ preference });
      writePreference(preference);
    },

    resolveEditor: () => {
      const { preference, detected } = get();
      if (!preference) return null;
      if (preference.kind === "custom") {
        return { name: preference.name, appPath: preference.appPath };
      }
      const match = detected.find((editor) => editor.id === preference.id);
      if (!match) return null;
      return { id: match.id, name: match.name, appPath: match.appPath };
    },

    openWithPreference: async (workspaceRoot, path, line) => {
      if (!isTextLikePath(path)) {
        await openFile(workspaceRoot, path);
        return true;
      }
      await get().detect();
      const editor = get().resolveEditor();
      if (!editor) return false;
      await openFile(workspaceRoot, path, { line, editor });
      return true;
    },
  }));
}

export const useExternalEditorStore = createExternalEditorStore();
