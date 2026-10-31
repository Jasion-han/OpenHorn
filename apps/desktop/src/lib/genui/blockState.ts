/**
 * What the user typed, ticked or moved inside a rendered ```openui-lang block,
 * kept per machine so it survives switching conversations and restarting.
 *
 * Keyed by `<scope>:<offset>` where scope identifies the message (and agent
 * text segment) and offset is where the block starts in the message text —
 * stable once the message is complete. Entries are capped in count and size;
 * the oldest are evicted first.
 */

const PREFIX = "openhorn.genUi.state:";
const INDEX_KEY = "openhorn.genUi.stateIndex";
export const MAX_ENTRIES = 300;
export const MAX_ENTRY_BYTES = 64 * 1024;

export interface BlockStateStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function defaultStorage(): BlockStateStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function blockStateKey(scope: string, offset: number): string {
  return `${scope}:${offset}`;
}

function readIndex(storage: BlockStateStorage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function loadBlockState(
  key: string,
  storage: BlockStateStorage | null = defaultStorage(),
): Record<string, unknown> | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveBlockState(
  key: string,
  state: Record<string, unknown>,
  storage: BlockStateStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const raw = JSON.stringify(state);
    if (raw.length > MAX_ENTRY_BYTES) return;
    storage.setItem(PREFIX + key, raw);
    const index = readIndex(storage).filter((k) => k !== key);
    index.push(key);
    while (index.length > MAX_ENTRIES) {
      const evicted = index.shift();
      if (evicted) storage.removeItem(PREFIX + evicted);
    }
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Full or blocked storage: the block keeps working, unsaved.
  }
}
