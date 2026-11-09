import { expect, test } from "bun:test";
import { createArtifactDraftStore } from "./artifactDraftStore";

const draft = {
  content: "Unsaved changes",
  format: "markdown" as const,
  sourceVersion: 1,
  expectedVersion: 1,
  originalContent: "Original",
  originalFormat: "markdown" as const,
};

test("artifact navigation retains independent drafts until explicit discard", () => {
  const store = createArtifactDraftStore("first-user");
  store.getState().put("one", draft);
  store.getState().select("two");
  store.getState().put("two", { ...draft, content: "Second draft" });
  store.getState().select("one");
  expect(store.getState().drafts.one.content).toBe("Unsaved changes");
  expect(store.getState().drafts.one.expectedVersion).toBe(1);
  store.getState().discard("one");
  expect(store.getState().drafts.one).toBe(undefined);
  expect(store.getState().drafts.two.content).toBe("Second draft");
});

test("logout or switching accounts clears drafts and selection", () => {
  const store = createArtifactDraftStore("first-user");
  store.getState().put("one", draft);
  store.getState().select("one");
  store.getState().setOwner("first-user");
  expect(store.getState().drafts.one.content).toBe(draft.content);
  store.getState().setOwner("second-user");
  expect(store.getState().drafts).toEqual({});
  expect(store.getState().selectedId).toBe(null);
  store.getState().put("one", draft);
  store.getState().setOwner(null);
  store.getState().put("one", draft);
  expect(store.getState().drafts).toEqual({});
});
