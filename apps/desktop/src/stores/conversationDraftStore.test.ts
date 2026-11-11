import { expect, test } from "bun:test";
import { createConversationDraftStore, mergeComposerHandoff } from "./conversationDraftStore";

test("conversation drafts preserve independent text and files until explicitly cleared", () => {
  const store = createConversationDraftStore("server-a:user");
  const first = new File(["first"], "draft.txt");
  const second = new File(["second"], "later.txt");
  store
    .getState()
    .update("server-a:user", "one", () => ({ text: "Edited source question", files: [first] }));
  store
    .getState()
    .update("server-a:user", "two", () => ({ text: "Another conversation", files: [second] }));
  expect(store.getState().drafts.one.text).toBe("Edited source question");
  expect(store.getState().drafts.one.files[0]).toBe(first);
  // A late completion removes only the original send's files, without touching the other chat.
  store
    .getState()
    .update("server-a:user", "one", (draft) => ({ ...draft, files: [...draft.files, second] }));
  store.getState().update("server-a:user", "one", (draft) => ({
    ...draft,
    files: draft.files.filter((file) => file !== first),
  }));
  expect(store.getState().drafts.one.files).toEqual([second]);
  expect(store.getState().drafts.two.text).toBe("Another conversation");
  store.getState().update("server-a:user", "one", () => ({ text: "", files: [] }));
  expect(store.getState().drafts.one).toBe(undefined);
});

test("owner changes drop all drafts and reject old asynchronous writers", () => {
  const store = createConversationDraftStore("server-a:user");
  const update = () =>
    store.getState().update("server-a:user", "one", () => ({ text: "Private draft", files: [] }));
  update();
  store.getState().bind("server-a:user");
  expect(store.getState().drafts.one.text).toBe("Private draft");
  store.getState().bind("server-b:user");
  update();
  expect(store.getState().drafts).toEqual({});
  store.getState().bind(null);
  store.getState().update(null, "one", () => ({ text: "No account", files: [] }));
  expect(store.getState().drafts).toEqual({});
});

test("editable handoffs retain revised text and restored drafts never trigger a send", () => {
  const file = new File(["draft"], "private.txt");
  const current = { text: "My edited question", files: [file] };
  expect(
    mergeComposerHandoff(current, { text: "Original sourced prompt", files: [], autoSend: false }),
  ).toMatchObject({ text: "My edited question", files: [file], autoSend: false });
  expect(
    mergeComposerHandoff(current, { text: "Explicit new welcome question", files: [] }),
  ).toMatchObject({
    text: "My edited question\n\nExplicit new welcome question",
    files: [file],
    autoSend: false,
    needsReview: true,
  });
  expect(
    mergeComposerHandoff({ text: "", files: [] }, { text: "New", files: [], autoSend: true }),
  ).toMatchObject({ text: "New", autoSend: true, needsReview: false });
});

test("imported conversation identifiers cannot address object prototype properties", () => {
  const store = createConversationDraftStore("owner");
  for (const id of ["__proto__", "constructor", "toString"]) {
    store.getState().update("owner", id, (current) => ({ ...current, text: id }));
    expect(store.getState().drafts[id].text).toBe(id);
  }
  expect(Object.keys(store.getState().drafts)).toEqual(["__proto__", "constructor", "toString"]);
});

test("delete and account ABA changes fence callbacks from the old draft lifetime", () => {
  const store = createConversationDraftStore("owner");
  const lease = { generation: store.getState().generation, revision: 0 };
  const put = () =>
    store.getState().update("owner", "one", () => ({ text: "old", files: [] }), lease);
  put();
  store.getState().discard("owner", "one", lease.generation);
  put();
  expect(store.getState().drafts.one).toBe(undefined);
  store.getState().update("owner", "one", () => ({ text: "new", files: [] }));
  expect(store.getState().drafts.one.text).toBe("new");
  store.getState().bind("another");
  store.getState().bind("owner");
  put();
  expect(store.getState().drafts.one).toBe(undefined);
});
