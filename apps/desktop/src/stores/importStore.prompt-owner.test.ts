import { expect, test } from "bun:test";
import type { ServerApi } from "../lib/serverApi";
import { createImportStore } from "./importStore";

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
