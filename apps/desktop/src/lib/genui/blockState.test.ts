import { describe, expect, test } from "bun:test";
import {
  type BlockStateStorage,
  blockStateKey,
  loadBlockState,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  MAX_TOTAL_BYTES,
  migrateBlockStateScope,
  rememberBlockState,
  saveBlockState,
} from "./blockState";

const PREFIX = "openhorn.genUi.state:";
const INDEX = "openhorn.genUi.stateIndex";
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength;

function memoryStorage(data = new Map<string, string>()) {
  let quota = Number.POSITIVE_INFINITY;
  let rejectIndex = false;
  const used = () => [...data].reduce((total, [key, value]) => total + byteSize(key + value), 0);
  const storage: BlockStateStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (key === INDEX && rejectIndex) throw new Error("index blocked");
      const previous = data.get(key);
      data.set(key, value);
      if (used() > quota) {
        if (previous === undefined) data.delete(key);
        else data.set(key, previous);
        throw new DOMException("full", "QuotaExceededError");
      }
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return {
    data,
    storage,
    used,
    setQuota: (value: number) => {
      quota = value;
    },
    rejectIndex: () => {
      rejectIndex = true;
    },
    // A distinct storage object simulates a restart, bypassing the memory cache.
    restart: (): BlockStateStorage => ({ ...storage }),
  };
}

describe("GenUI program state ownership", () => {
  test("separates replacement programs and can restore a canceled retry's original program", () => {
    const { storage } = memoryStorage();
    const original = blockStateKey("reply", 0, "$x=1\nroot=Text($x)");
    const replacement = blockStateKey("reply", 0, "$x=2\nroot=Text($x)");
    saveBlockState(original, { $x: 42 }, storage);
    expect(loadBlockState(replacement, storage)).toBe(undefined);
    expect(loadBlockState(original, storage)).toEqual({ $x: 42 });
    expect(blockStateKey("reply", 0)).toBe("reply:0");
  });

  test("publishes an isolated snapshot before the disk debounce and keeps storages independent", () => {
    const first = memoryStorage();
    const second = memoryStorage();
    const state = { $selected: ["a"] };
    rememberBlockState("reply:0", state, first.storage);
    state.$selected.push("b");
    expect(first.data.size).toBe(0);
    expect(loadBlockState("reply:0", first.storage)).toEqual({ $selected: ["a"] });
    expect(loadBlockState("reply:0", second.storage)).toBe(undefined);
  });

  test("an old unmount flush cannot overwrite the latest synchronously published value", () => {
    const { storage, restart } = memoryStorage();
    const old = { $x: 1 };
    const current = { $x: 42 };
    rememberBlockState("reply:0", old, storage);
    rememberBlockState("reply:0", current, storage);
    saveBlockState("reply:0", old, storage);
    expect(loadBlockState("reply:0", restart())).toEqual(current);
  });

  test("migrates every Agent step and program revision and aliases delayed old-id writes", () => {
    const { storage, restart } = memoryStorage();
    const first = blockStateKey("temp-reply:0", 0, "program-a");
    const second = blockStateKey("temp-reply:3", 24, "program-b");
    const pending = { $x: 42 };
    saveBlockState(first, { $x: 1 }, storage);
    saveBlockState(second, { $done: true }, storage);
    saveBlockState("temp-reply-other:0", { $x: "unrelated" }, storage);
    rememberBlockState(first, pending, storage);
    migrateBlockStateScope("temp-reply", "persisted-reply", storage);
    const moved = blockStateKey("persisted-reply:0", 0, "program-a");
    expect(loadBlockState(moved, storage)).toEqual(pending);
    expect(loadBlockState(blockStateKey("persisted-reply:3", 24, "program-b"), restart())).toEqual({
      $done: true,
    });
    expect(storage.getItem(PREFIX + first)).toBe(null);
    expect(loadBlockState("temp-reply-other:0", storage)).toEqual({ $x: "unrelated" });
    const newest = { $x: 99 };
    rememberBlockState(moved, newest, storage);
    saveBlockState(first, pending, storage);
    expect(loadBlockState(moved, restart())).toEqual(newest);
    expect(storage.getItem(PREFIX + first)).toBe(null);
  });

  test("migrates cache-only state and resolves chained aliases for pending saves", () => {
    const { storage, restart } = memoryStorage();
    const pending = { $x: 42 };
    rememberBlockState("temp:0:0", pending, storage);
    migrateBlockStateScope("temp", "saved", storage);
    migrateBlockStateScope("saved", "final", storage);
    saveBlockState("temp:0:0", pending, storage);
    expect(loadBlockState("final:0:0", restart())).toEqual(pending);
    expect(storage.getItem(`${PREFIX}temp:0:0`)).toBe(null);
    expect(storage.getItem(`${PREFIX}saved:0:0`)).toBe(null);
  });

  test("keeps immediate state available even with blocked storage", () => {
    const storage: BlockStateStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    rememberBlockState("temp:0", { $x: 42 }, storage);
    migrateBlockStateScope("temp", "saved", storage);
    saveBlockState("temp:0", { $x: 42 }, storage);
    expect(loadBlockState("saved:0", storage)).toEqual({ $x: 42 });
  });
});

describe("GenUI persistence bounds and recovery", () => {
  test("caps the immediate cache independently of disk writes", () => {
    const { storage } = memoryStorage();
    for (let i = 0; i <= MAX_ENTRIES; i++) rememberBlockState(`cache:${i}`, { $x: i }, storage);
    expect(loadBlockState("cache:0", storage)).toBe(undefined);
    expect(loadBlockState(`cache:${MAX_ENTRIES}`, storage)).toEqual({ $x: MAX_ENTRIES });
  });

  test("enforces UTF-8 entry bytes for multibyte text and rejects cyclic state", () => {
    const { storage, data } = memoryStorage();
    const oversized = { $text: "汉".repeat(Math.ceil(MAX_ENTRY_BYTES / 3)) };
    expect(JSON.stringify(oversized).length < MAX_ENTRY_BYTES).toBe(true);
    saveBlockState("oversized", oversized, storage);
    expect(loadBlockState("oversized", storage)).toBe(undefined);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    saveBlockState("cyclic", cyclic, storage);
    expect(data.size).toBe(0);
  });

  test("evicts by aggregate byte budget before reaching the entry count", () => {
    const { storage, data, restart } = memoryStorage();
    const state = { $text: "汉".repeat(20_000) };
    for (let i = 0; i < 75; i++) saveBlockState(`bytes:${i}`, state, storage);
    const payloadBytes = [...data]
      .filter(([key]) => key.startsWith(PREFIX))
      .reduce((total, [key, value]) => total + byteSize(key + value), 0);
    expect(payloadBytes <= MAX_TOTAL_BYTES).toBe(true);
    expect(loadBlockState("bytes:0", restart())).toBe(undefined);
    expect(loadBlockState("bytes:74", restart())).toEqual(state);
  });

  test("evicts before writing the next entry at the count cap", () => {
    const fixture = memoryStorage();
    const state = { $text: "a".repeat(200) };
    for (let i = 0; i < MAX_ENTRIES; i++) saveBlockState(`k${i}`, state, fixture.storage);
    fixture.setQuota(fixture.used() + 30);
    saveBlockState("replacement", state, fixture.storage);
    expect(loadBlockState("k0", fixture.restart())).toBe(undefined);
    expect(loadBlockState("replacement", fixture.restart())).toEqual(state);
  });

  test("recovers from shared storage quota before reaching the count cap", () => {
    const fixture = memoryStorage();
    saveBlockState("oldest", { $text: "a".repeat(600) }, fixture.storage);
    saveBlockState("recent", { $text: "b".repeat(600) }, fixture.storage);
    fixture.setQuota(fixture.used() + 20);
    saveBlockState("new", { $text: "c".repeat(600) }, fixture.storage);
    expect(loadBlockState("oldest", fixture.restart())).toBe(undefined);
    expect(loadBlockState("new", fixture.restart())).toEqual({ $text: "c".repeat(600) });
  });

  test("disk eviction preserves another block's newer debounced memory snapshot", () => {
    const fixture = memoryStorage();
    saveBlockState("edited", { $text: "a".repeat(600), $value: 1 }, fixture.storage);
    const latest = { $text: "a".repeat(600), $value: 42 };
    rememberBlockState("edited", latest, fixture.storage);
    fixture.setQuota(fixture.used() + 20);
    saveBlockState("other", { $text: "b".repeat(600) }, fixture.storage);
    expect(fixture.storage.getItem(`${PREFIX}edited`)).toBe(null);
    // A component remount restores the latest edit before its old cleanup runs.
    expect(loadBlockState("edited", fixture.storage)).toEqual(latest);
    saveBlockState("edited", latest, fixture.storage);
    expect(loadBlockState("edited", fixture.restart())).toEqual(latest);
  });

  test("rolls back a new unindexed payload if writing its index is blocked", () => {
    const fixture = memoryStorage();
    saveBlockState("existing", { $x: 1 }, fixture.storage);
    fixture.rejectIndex();
    saveBlockState("unindexed", { $x: 2 }, fixture.storage);
    expect(fixture.storage.getItem(`${PREFIX}unindexed`)).toBe(null);
    expect(loadBlockState("existing", fixture.restart())).toEqual({ $x: 1 });
    expect(loadBlockState("unindexed", fixture.storage)).toEqual({ $x: 2 });
  });

  test("a corrupt index does not permanently disable subsequent saves", () => {
    const fixture = memoryStorage();
    fixture.data.set(INDEX, "{bad-json");
    fixture.data.set(`${PREFIX}broken`, "{bad-json");
    expect(loadBlockState("broken", fixture.storage)).toBe(undefined);
    saveBlockState("recovered", { $x: 42 }, fixture.storage);
    expect(loadBlockState("recovered", fixture.restart())).toEqual({ $x: 42 });
    expect(JSON.parse(fixture.storage.getItem(INDEX) ?? "null")).toEqual(["recovered"]);
  });
});
