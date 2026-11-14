import { expect, test } from "bun:test";
import { createGeneralSettingsStore } from "./generalSettingsStore";

test("reconnect preserves an edited instruction and failed save keeps it retryable", async () => {
  let remote = "Original";
  let fail = true;
  const store = createGeneralSettingsStore(
    {
      read: async () => remote,
      write: async (value) => {
        if (fail) throw new Error("synthetic");
        remote = value;
      },
    },
    "one",
  );
  await store.getState().load();
  store.getState().edit();
  store.getState().setValue("Draft");
  remote = "Changed elsewhere";
  await store.getState().load();
  expect(store.getState().value).toBe("Draft");
  expect(store.getState().savedValue).toBe("Changed elsewhere");
  expect(await store.getState().save()).toBe(false);
  expect(store.getState().error).toBe("save");
  expect(store.getState().value).toBe("Draft");
  fail = false;
  expect(await store.getState().save()).toBe(true);
  expect(remote).toBe("Draft");
  expect(store.getState().editing).toBe(false);
});

test("saving submits a fixed draft once and supersedes older reloads", async () => {
  let readCalls = 0;
  let resolveLoad!: (text: string) => void;
  let resolveSave!: () => void;
  const writes: string[] = [];
  const store = createGeneralSettingsStore(
    {
      read: async () =>
        ++readCalls === 1
          ? "Original"
          : new Promise<string>((done) => {
              resolveLoad = done;
            }),
      write: async (value) => {
        writes.push(value);
        await new Promise<void>((done) => {
          resolveSave = done;
        });
      },
    },
    "one",
  );
  await store.getState().load();
  store.getState().edit();
  store.getState().setValue("Draft");
  const loading = store.getState().load();
  const saving = store.getState().save();
  store.getState().setValue("Changed during save");
  expect(await store.getState().save()).toBe(false);
  expect(writes).toEqual(["Draft"]);
  resolveSave();
  expect(await saving).toBe(true);
  resolveLoad("Old response");
  await loading;
  expect(store.getState().value).toBe("Draft");
  expect(store.getState().savedValue).toBe("Draft");
});

test("account changes clear instruction drafts and reject late responses", async () => {
  let resolve!: (text: string) => void;
  const store = createGeneralSettingsStore(
    {
      read: () =>
        new Promise((done) => {
          resolve = done;
        }),
      write: async () => {},
    },
    "one",
  );
  const loading = store.getState().load();
  store.getState().setOwner("two");
  resolve("First account instructions");
  await loading;
  expect(store.getState().value).toBe("");
  expect(store.getState().loaded).toBe(false);
  expect(store.getState().ownerId).toBe("two");
});

test("load failure cannot turn unknown instructions into an editable empty setting", async () => {
  const store = createGeneralSettingsStore(
    {
      read: async () => {
        throw new Error("synthetic");
      },
      write: async () => {
        throw new Error("Must not save before load");
      },
    },
    "one",
  );
  await store.getState().load();
  expect(store.getState().error).toBe("load");
  store.getState().edit();
  store.getState().setValue("Overwrite");
  expect(store.getState().editing).toBe(false);
  expect(await store.getState().save()).toBe(false);
});
