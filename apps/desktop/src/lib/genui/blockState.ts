/**
 * Interaction state belongs to a message's UI program, independently of React
 * mounts, optimistic message ids and the debounced localStorage write.
 */
const PREFIX = "openhorn.genUi.state:";
const INDEX_KEY = "openhorn.genUi.stateIndex";
export const MAX_ENTRIES = 300;
export const MAX_ENTRY_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface BlockStateStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

type Snapshot = {
  raw: string;
  bytes: number;
  value: Record<string, unknown>;
  revision: number;
};

type StateCache = {
  entries: Map<string, Snapshot>;
  aliases: Map<string, string>;
  remembered: WeakMap<Record<string, unknown>, { key: string; revision: number }>;
  sequence: number;
};

const caches = new WeakMap<BlockStateStorage, StateCache>();
const memoryOnlyCache = createCache();
const encoder = new TextEncoder();

function createCache(): StateCache {
  return { entries: new Map(), aliases: new Map(), remembered: new WeakMap(), sequence: 0 };
}

function cacheFor(storage: BlockStateStorage | null): StateCache {
  if (!storage) return memoryOnlyCache;
  let cache = caches.get(storage);
  if (!cache) {
    cache = createCache();
    caches.set(storage, cache);
  }
  return cache;
}

function defaultStorage(): BlockStateStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Two independent 32-bit hashes keep large program text out of storage keys. */
function programRevision(program: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < program.length; index++) {
    const code = program.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${program.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

/** A replaced program gets its own state; a canceled retry can reopen the old one. */
export function blockStateKey(scope: string, offset: number, program?: string): string {
  const base = `${scope}:${offset}`;
  return program === undefined ? base : `${base}:v2:${programRevision(program)}`;
}

function inScope(key: string, scope: string): boolean {
  return key === scope || key.startsWith(`${scope}:`);
}

function resolveKey(cache: StateCache, key: string): string {
  const visited = new Set<string>();
  while (!visited.has(key)) {
    visited.add(key);
    let source: string | undefined;
    for (const alias of cache.aliases.keys()) {
      if (inScope(key, alias) && (!source || alias.length > source.length)) source = alias;
    }
    if (!source) break;
    key = `${cache.aliases.get(source)}${key.slice(source.length)}`;
  }
  return key;
}

function byteSize(value: string): number {
  return encoder.encode(value).byteLength;
}

function snapshot(raw: string, cache: StateCache): Snapshot | undefined {
  const bytes = byteSize(raw);
  if (bytes > MAX_ENTRY_BYTES) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { raw, bytes, value: value as Record<string, unknown>, revision: ++cache.sequence };
}

function remember(cache: StateCache, key: string, entry: Snapshot): void {
  cache.entries.delete(key);
  cache.entries.set(key, entry);
  let bytes = 0;
  for (const [name, value] of cache.entries) bytes += byteSize(name) + value.bytes;
  while (cache.entries.size > MAX_ENTRIES || bytes > MAX_TOTAL_BYTES) {
    const oldest = cache.entries.entries().next().value;
    if (!oldest) break;
    cache.entries.delete(oldest[0]);
    bytes -= byteSize(oldest[0]) + oldest[1].bytes;
  }
}

function readIndex(storage: BlockStateStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((key): key is string => typeof key === "string"))]
      : [];
  } catch {
    return [];
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

/** Evict before writing, and retry against the browser's real shared quota. */
function persist(storage: BlockStateStorage, key: string, entry: Snapshot): boolean {
  try {
    const previousIndex = readIndex(storage);
    const retained = previousIndex.filter((name) => name !== key);
    const sizes = new Map<string, number>();
    let bytes = byteSize(PREFIX + key) + entry.bytes;
    for (const name of retained) {
      const raw = storage.getItem(PREFIX + name);
      const size = raw === null ? 0 : byteSize(PREFIX + name) + byteSize(raw);
      sizes.set(name, size);
      bytes += size;
    }
    const evict = (): boolean => {
      const victim = retained.shift();
      if (victim === undefined) return false;
      storage.removeItem(PREFIX + victim);
      // Disk quota is independent of the memory budget. A mounted block can
      // have a newer snapshot here while its own persistence is debounced.
      bytes -= sizes.get(victim) ?? 0;
      return true;
    };
    while (retained.length + 1 > MAX_ENTRIES || bytes > MAX_TOTAL_BYTES) {
      if (!evict()) return false;
    }
    for (;;) {
      try {
        storage.setItem(PREFIX + key, entry.raw);
        break;
      } catch (error) {
        if (!isQuotaError(error) || !evict()) return false;
      }
    }
    for (;;) {
      try {
        storage.setItem(INDEX_KEY, JSON.stringify([...retained, key]));
        return true;
      } catch (error) {
        if (isQuotaError(error) && evict()) continue;
        // A new payload without an index entry would never be evicted again.
        if (!previousIndex.includes(key)) storage.removeItem(PREFIX + key);
        return false;
      }
    }
  } catch {
    return false;
  }
}

export function loadBlockState(
  key: string,
  storage: BlockStateStorage | null = defaultStorage(),
): Record<string, unknown> | undefined {
  const cache = cacheFor(storage);
  key = resolveKey(cache, key);
  const current = cache.entries.get(key);
  if (current) return current.value;
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(PREFIX + key);
    const entry = raw ? snapshot(raw, cache) : undefined;
    if (!entry) return undefined;
    remember(cache, key, entry);
    return entry.value;
  } catch {
    return undefined;
  }
}

/** Publish immediately; disk persistence can still be debounced by the caller. */
export function rememberBlockState(
  key: string,
  state: Record<string, unknown>,
  storage: BlockStateStorage | null = defaultStorage(),
): void {
  const cache = cacheFor(storage);
  key = resolveKey(cache, key);
  try {
    const entry = snapshot(JSON.stringify(state), cache);
    if (!entry) return;
    remember(cache, key, entry);
    cache.remembered.set(state, { key, revision: entry.revision });
  } catch {
    // Cyclic or oversized values cannot be persisted. The mounted UI still works.
  }
}

export function saveBlockState(
  key: string,
  state: Record<string, unknown>,
  storage: BlockStateStorage | null = defaultStorage(),
): void {
  const cache = cacheFor(storage);
  key = resolveKey(cache, key);
  const source = cache.remembered.get(state);
  let entry = cache.entries.get(key);
  // An old component's delayed cleanup must not overwrite a newer snapshot,
  // including when the old optimistic message id has just been reconciled.
  if (!entry || !source || resolveKey(cache, source.key) !== key) {
    rememberBlockState(key, state, storage);
    entry = cache.entries.get(key);
  } else if (source.revision > entry.revision) {
    rememberBlockState(key, state, storage);
    entry = cache.entries.get(key);
  }
  if (storage && entry) persist(storage, key, entry);
}

/** Rename every program/Agent-step state, including writes still pending on old ids. */
export function migrateBlockStateScope(
  fromScope: string,
  toScope: string,
  storage: BlockStateStorage | null = defaultStorage(),
): void {
  if (fromScope === toScope) return;
  const cache = cacheFor(storage);
  const from = resolveKey(cache, fromScope);
  const to = resolveKey(cache, toScope);
  if (from === to) return;
  const diskEntries = new Map<string, Snapshot>();
  if (storage) {
    try {
      for (const key of readIndex(storage)) {
        if (!inScope(key, from)) continue;
        const raw = storage.getItem(PREFIX + key);
        const entry = raw ? snapshot(raw, cache) : undefined;
        if (entry) diskEntries.set(key, entry);
      }
    } catch {
      // Memory snapshots and pending writes can still migrate with blocked storage.
    }
  }
  cache.aliases.set(fromScope, to);
  cache.aliases.set(from, to);
  while (cache.aliases.size > MAX_ENTRIES * 2) {
    const oldest = cache.aliases.keys().next().value;
    if (oldest !== undefined) cache.aliases.delete(oldest);
  }
  // Prefer the in-memory value over an older disk value waiting for its debounce.
  for (const [key, entry] of cache.entries) {
    if (inScope(key, from)) diskEntries.set(key, entry);
  }
  for (const [oldKey, entry] of diskEntries) {
    const newKey = `${to}${oldKey.slice(from.length)}`;
    cache.entries.delete(oldKey);
    remember(cache, newKey, entry);
    if (storage) {
      try {
        // Free the old payload before rewriting under the slightly longer id.
        storage.removeItem(PREFIX + oldKey);
        storage.setItem(
          INDEX_KEY,
          JSON.stringify(readIndex(storage).filter((key) => key !== oldKey)),
        );
      } catch {
        // persist() remains best effort; the in-memory alias is already live.
      }
      persist(storage, newKey, entry);
    }
  }
}
