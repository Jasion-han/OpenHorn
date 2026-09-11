import { describe, expect, test } from "bun:test";
import type { DetectedEditor } from "../lib/tauriBridge";
import {
  createExternalEditorStore,
  type EditorPreferenceStorage,
  EXTERNAL_EDITOR_STORAGE_KEY,
  editorNameFromAppPath,
  parseEditorPreference,
} from "./externalEditorStore";

function memoryStorage(initial: Record<string, string> = {}): EditorPreferenceStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null) ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const DETECTED: DetectedEditor[] = [
  { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app", supportsLine: true },
  { id: "xcode", name: "Xcode", appPath: "/Applications/Xcode.app", supportsLine: false },
];

const detectEditors = async () => DETECTED;

describe("external editor store", () => {
  test("starts unset with nothing detected", () => {
    const store = createExternalEditorStore({ storage: memoryStorage(), detectEditors });
    expect(store.getState().preference).toBe(null);
    expect(store.getState().detected).toHaveLength(0);
    expect(store.getState().resolveEditor()).toBe(null);
  });

  test("setPreference persists to storage and clearing removes the key", () => {
    const storage = memoryStorage();
    const store = createExternalEditorStore({ storage, detectEditors });
    store.getState().setPreference({ kind: "detected", id: "cursor" });
    expect(JSON.parse(storage.data[EXTERNAL_EDITOR_STORAGE_KEY] ?? "null")).toEqual({
      kind: "detected",
      id: "cursor",
    });
    store.getState().setPreference(null);
    expect(storage.data[EXTERNAL_EDITOR_STORAGE_KEY]).toBe(undefined);
  });

  test("reads a persisted preference on creation", () => {
    const storage = memoryStorage({
      [EXTERNAL_EDITOR_STORAGE_KEY]: JSON.stringify({
        kind: "custom",
        name: "Nova",
        appPath: "/Applications/Nova.app",
      }),
    });
    const store = createExternalEditorStore({ storage, detectEditors });
    expect(store.getState().preference).toEqual({
      kind: "custom",
      name: "Nova",
      appPath: "/Applications/Nova.app",
    });
    // Custom editors resolve without detection.
    expect(store.getState().resolveEditor()).toEqual({
      name: "Nova",
      appPath: "/Applications/Nova.app",
    });
  });

  test("ignores corrupt or unknown persisted values", () => {
    expect(parseEditorPreference("not json")).toBe(null);
    expect(parseEditorPreference(JSON.stringify({ kind: "other" }))).toBe(null);
    expect(parseEditorPreference(JSON.stringify({ kind: "detected" }))).toBe(null);
    expect(parseEditorPreference(JSON.stringify({ kind: "custom", name: "x" }))).toBe(null);
    const storage = memoryStorage({ [EXTERNAL_EDITOR_STORAGE_KEY]: "{garbage" });
    const store = createExternalEditorStore({ storage, detectEditors });
    expect(store.getState().preference).toBe(null);
  });

  test("detect runs once and a detected preference resolves against it", async () => {
    let calls = 0;
    const store = createExternalEditorStore({
      storage: memoryStorage(),
      detectEditors: async () => {
        calls += 1;
        return DETECTED;
      },
    });
    store.getState().setPreference({ kind: "detected", id: "cursor" });
    // Not detected yet: treated as unset.
    expect(store.getState().resolveEditor()).toBe(null);

    await store.getState().detect();
    await store.getState().detect();
    expect(calls).toBe(1);
    expect(store.getState().detectStatus).toBe("done");
    expect(store.getState().detected).toHaveLength(2);
    expect(store.getState().resolveEditor()).toEqual({
      id: "cursor",
      name: "Cursor",
      appPath: "/Applications/Cursor.app",
    });
  });

  test("a detected preference whose editor is gone resolves to null", async () => {
    const store = createExternalEditorStore({ storage: memoryStorage(), detectEditors });
    store.getState().setPreference({ kind: "detected", id: "zed" });
    await store.getState().detect();
    expect(store.getState().resolveEditor()).toBe(null);
    // The stale preference itself is kept so it comes back if the editor is reinstalled.
    expect(store.getState().preference).toEqual({ kind: "detected", id: "zed" });
  });

  test("detection failure yields an empty list instead of throwing", async () => {
    const store = createExternalEditorStore({
      storage: memoryStorage(),
      detectEditors: async () => {
        throw new Error("not in tauri");
      },
    });
    const detected = await store.getState().detect();
    expect(detected).toHaveLength(0);
    expect(store.getState().detectStatus).toBe("done");
  });

  test("works without any storage", () => {
    const store = createExternalEditorStore({ storage: null, detectEditors });
    store.getState().setPreference({ kind: "detected", id: "cursor" });
    expect(store.getState().preference).toEqual({ kind: "detected", id: "cursor" });
  });
});

describe("openWithPreference", () => {
  type OpenCall = Parameters<typeof import("../lib/tauriBridge").openWorkspaceFile>;

  function storeWithRecorder(initial: Record<string, string> = {}) {
    const calls: OpenCall[] = [];
    const store = createExternalEditorStore({
      storage: memoryStorage(initial),
      detectEditors,
      openFile: async (...args) => {
        calls.push(args);
      },
    });
    return { store, calls };
  }

  test("non-text files always go to the OS default app, even with an editor chosen", async () => {
    const { store, calls } = storeWithRecorder();
    store.getState().setPreference({ kind: "detected", id: "cursor" });
    expect(await store.getState().openWithPreference("/ws", "assets/logo.png", 3)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["/ws", "assets/logo.png"]);
  });

  test("text files use the resolved editor with the line", async () => {
    const { store, calls } = storeWithRecorder();
    store.getState().setPreference({ kind: "detected", id: "cursor" });
    expect(await store.getState().openWithPreference("/ws", "src/a.ts", 42)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "/ws",
      "src/a.ts",
      { line: 42, editor: { id: "cursor", name: "Cursor", appPath: "/Applications/Cursor.app" } },
    ]);
  });

  test("text files without a usable preference open nothing and report false", async () => {
    const { store, calls } = storeWithRecorder();
    expect(await store.getState().openWithPreference("/ws", "src/a.ts", 42)).toBe(false);
    store.getState().setPreference({ kind: "detected", id: "zed" });
    expect(await store.getState().openWithPreference("/ws", "src/a.ts", 42)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("editorNameFromAppPath", () => {
  test("strips the folder and the .app suffix", () => {
    expect(editorNameFromAppPath("/Applications/Sublime Text.app")).toBe("Sublime Text");
    expect(editorNameFromAppPath("/Users/me/Applications/Nova.app/")).toBe("Nova");
    expect(editorNameFromAppPath("/usr/bin/vim")).toBe("vim");
  });
});
