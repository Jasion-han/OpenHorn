import { expect, test } from "bun:test";
import type { ServerApi } from "../lib/serverApi";
import type { ApiImportRecord } from "../types/chat";
import { createImportStore } from "./importStore";

function record(id: string): ApiImportRecord {
  return {
    id,
    userId: "fixture",
    source: "file",
    kind: "backup",
    parts: [],
    errors: [],
    totalImported: 0,
    totalNeedsAction: 0,
    createdAt: new Date().toISOString(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("late history refresh cannot resurrect a successfully deleted record", async () => {
  const read = deferred<{ records: ApiImportRecord[] }>();
  const store = createImportStore({
    api: {
      importRecords: { list: () => read.promise, remove: async () => ({ success: true }) },
    } as unknown as ServerApi,
  });
  const old = record("deleted");
  store.setState({ records: [old] });
  const loading = store.getState().loadRecords();
  await store.getState().removeRecord(old.id);
  read.resolve({ records: [old] });
  await loading;
  expect(store.getState().records).toEqual([]);
  expect(store.getState().recordsLoading).toBe(false);
});

test("a superseded page cannot append to a fresh history or replace its cursor", async () => {
  const page = deferred<{ records: ApiImportRecord[]; nextCursor: string }>();
  const fresh = record("fresh");
  const store = createImportStore({
    api: {
      importRecords: {
        list: async (options?: { cursor?: string }) =>
          options?.cursor ? page.promise : { records: [fresh], nextCursor: "fresh-next" },
      },
    } as unknown as ServerApi,
  });
  store.setState({ records: [record("old-first")], recordsCursor: "old-page" });
  const paging = store.getState().loadMoreRecords();
  await store.getState().loadRecords();
  page.resolve({ records: [record("old-second")], nextCursor: "old-next" });
  await paging;
  expect(store.getState().records.map((row) => row.id)).toEqual([fresh.id]);
  expect(store.getState().recordsCursor).toBe("fresh-next");
});

test("picked MCP additions do not mutate a previous scan snapshot", () => {
  const store = createImportStore();
  const entry = (name: string) => ({
    name,
    client: "fixture",
    clients: ["fixture"],
    type: "stdio",
    config: { command: "fixture" },
    signature: name,
  });
  const first = store.getState().addPickedMcp([entry("one")]);
  store.getState().addPickedMcp([entry("two")]);
  expect(first.mcp?.entries.map((row) => row.name)).toEqual(["one"]);
  expect(store.getState().sources[0].mcp?.entries).toHaveLength(2);
});

test("a prompt roster loaded under an older account cannot replace the current roster", async () => {
  const { useAuthStore } = await import("./authStore");
  const previous = useAuthStore.getState();
  let release!: (value: []) => void;
  const store = createImportStore({
    api: {
      prompts: {
        templates: async () =>
          new Promise<[]>((done) => {
            release = done;
          }),
      },
    } as unknown as ServerApi,
  });
  try {
    useAuthStore
      .getState()
      .setUser({ id: "prompt-owner-a", username: "A", email: "a@test.invalid" });
    const pending = store.getState().loadPromptTemplates();
    useAuthStore
      .getState()
      .setUser({ id: "prompt-owner-b", username: "B", email: "b@test.invalid" });
    useAuthStore
      .getState()
      .setUser({ id: "prompt-owner-a", username: "A", email: "a@test.invalid" });
    store.setState({
      promptTemplates: [
        { id: "new", name: "Current", body: "Keep current", importedAt: 1, source: "file" },
      ],
    });
    release([]);
    await pending;
    expect(store.getState().promptTemplates.map((row) => row.id)).toEqual(["new"]);
  } finally {
    useAuthStore.setState(previous, true);
  }
});
