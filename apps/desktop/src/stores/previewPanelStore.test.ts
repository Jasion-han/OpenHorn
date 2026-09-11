import { describe, expect, test } from "bun:test";
import {
  clampPreviewPanelWidth,
  createPreviewPanelStore,
  generatePreviewTabId,
  PREVIEW_PANEL_DEFAULT_WIDTH,
  PREVIEW_PANEL_MIN_WIDTH,
} from "./previewPanelStore";

describe("preview panel store", () => {
  test("starts closed with the default width", () => {
    const store = createPreviewPanelStore();
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().tabs).toHaveLength(0);
    expect(store.getState().width).toBe(PREVIEW_PANEL_DEFAULT_WIDTH);
  });

  test("openFile opens the panel and activates a new tab", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "src/a.ts", line: 3, endLine: 5, conversationId: "c1" });
    const state = store.getState();
    expect(state.isOpen).toBe(true);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id ?? null);
    expect(state.tabs[0]).toMatchObject({
      kind: "file",
      path: "src/a.ts",
      line: 3,
      endLine: 5,
      conversationId: "c1",
    });
  });

  test("openFile reuses the tab for the same path and updates its range", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "src/a.ts", line: 3 });
    store.getState().openFile({ path: "src/b.ts" });
    store.getState().openFile({ path: "src/a.ts", line: 40, endLine: 44 });
    const state = store.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toMatchObject({ path: "src/a.ts", line: 40, endLine: 44 });
    expect(state.activeTabId).toBe(state.tabs[0]?.id ?? null);
  });

  test("openUrl reuses the tab for the same url", () => {
    const store = createPreviewPanelStore();
    store.getState().openUrl("https://a.com/");
    store.getState().openUrl("https://b.com/");
    store.getState().openUrl("https://a.com/");
    const state = store.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toMatchObject({ kind: "web", url: "https://a.com/", loading: true });
    expect(state.activeTabId).toBe(state.tabs[0]?.id ?? null);
  });

  test("web tabs start with no history in either direction", () => {
    const store = createPreviewPanelStore();
    store.getState().openUrl("https://a.com/");
    expect(store.getState().tabs[0]).toMatchObject({ canGoBack: false, canGoForward: false });
  });

  test("closing the active tab activates its right neighbour, then the left one", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().openFile({ path: "b" });
    store.getState().openFile({ path: "c" });
    const [a, b, c] = store.getState().tabs.map((tab) => tab.id);
    if (!a || !b || !c) throw new Error("expected three tabs");

    store.getState().activateTab(b);
    store.getState().closeTab(b);
    expect(store.getState().activeTabId).toBe(c);

    store.getState().closeTab(c);
    expect(store.getState().activeTabId).toBe(a);
  });

  test("closing a background tab keeps the active tab", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().openFile({ path: "b" });
    const [a, b] = store.getState().tabs.map((tab) => tab.id);
    if (!a || !b) throw new Error("expected two tabs");
    store.getState().closeTab(a);
    expect(store.getState().activeTabId).toBe(b);
    expect(store.getState().isOpen).toBe(true);
  });

  test("closing the last tab closes the panel", () => {
    const store = createPreviewPanelStore();
    store.getState().openUrl("https://a.com/");
    const id = store.getState().tabs[0]?.id ?? "";
    store.getState().closeTab(id);
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().activeTabId).toBe(null);
  });

  test("collapsePanel hides an open panel without dropping tabs; expandPanel restores it", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().openUrl("https://a.com/");
    store.getState().collapsePanel();
    expect(store.getState().collapsed).toBe(true);
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().tabs).toHaveLength(2);
    store.getState().expandPanel();
    expect(store.getState().collapsed).toBe(false);
    expect(store.getState().isOpen).toBe(true);
  });

  test("togglePanel flips collapsed only while the panel is open", () => {
    const store = createPreviewPanelStore();
    store.getState().togglePanel();
    expect(store.getState().collapsed).toBe(false);
    store.getState().collapsePanel();
    expect(store.getState().collapsed).toBe(false);

    store.getState().openFile({ path: "a" });
    store.getState().togglePanel();
    expect(store.getState().collapsed).toBe(true);
    store.getState().togglePanel();
    expect(store.getState().collapsed).toBe(false);
  });

  test("opening new content expands a collapsed panel", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().collapsePanel();
    store.getState().openFile({ path: "b" });
    expect(store.getState().collapsed).toBe(false);

    store.getState().collapsePanel();
    store.getState().openUrl("https://a.com/");
    expect(store.getState().collapsed).toBe(false);

    // Re-opening an existing tab counts too.
    store.getState().collapsePanel();
    store.getState().openFile({ path: "a", line: 2 });
    expect(store.getState().collapsed).toBe(false);
    expect(store.getState().tabs).toHaveLength(3);
  });

  test("closing a tab while collapsed keeps the panel collapsed", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().openFile({ path: "b" });
    store.getState().collapsePanel();
    const id = store.getState().tabs[1]?.id ?? "";
    store.getState().closeTab(id);
    expect(store.getState().isOpen).toBe(true);
    expect(store.getState().collapsed).toBe(true);
  });

  test("closing the last tab of a collapsed panel closes it and resets collapsed", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().collapsePanel();
    const id = store.getState().tabs[0]?.id ?? "";
    store.getState().closeTab(id);
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().collapsed).toBe(false);
    expect(store.getState().tabs).toHaveLength(0);
  });

  test("closePanel drops every tab", () => {
    const store = createPreviewPanelStore();
    store.getState().openFile({ path: "a" });
    store.getState().openUrl("https://a.com/");
    store.getState().closePanel();
    expect(store.getState().isOpen).toBe(false);
    expect(store.getState().tabs).toHaveLength(0);
  });

  test("updateTab patches web tab url/title/loading", () => {
    const store = createPreviewPanelStore();
    store.getState().openUrl("https://a.com/");
    const id = store.getState().tabs[0]?.id ?? "";
    store.getState().updateTab(id, { url: "https://a.com/next", title: "Next", loading: false });
    expect(store.getState().tabs[0]).toMatchObject({
      url: "https://a.com/next",
      title: "Next",
      loading: false,
    });
  });

  test("updateTab patches history availability independently of other fields", () => {
    const store = createPreviewPanelStore();
    store.getState().openUrl("https://a.com/");
    const id = store.getState().tabs[0]?.id ?? "";
    store.getState().updateTab(id, { canGoBack: true, canGoForward: false });
    expect(store.getState().tabs[0]).toMatchObject({
      url: "https://a.com/",
      loading: true,
      canGoBack: true,
      canGoForward: false,
    });
    store.getState().updateTab(id, { canGoForward: true });
    expect(store.getState().tabs[0]).toMatchObject({ canGoBack: true, canGoForward: true });
  });

  test("setWidth clamps to the minimum", () => {
    const store = createPreviewPanelStore();
    store.getState().setWidth(100);
    expect(store.getState().width).toBe(PREVIEW_PANEL_MIN_WIDTH);
  });

  test("clampPreviewPanelWidth caps at 70% of the window", () => {
    expect(clampPreviewPanelWidth(2000, 1000)).toBe(700);
    expect(clampPreviewPanelWidth(500, 1000)).toBe(500);
    expect(clampPreviewPanelWidth(10, 1000)).toBe(PREVIEW_PANEL_MIN_WIDTH);
    expect(clampPreviewPanelWidth(Number.NaN, 1000)).toBe(PREVIEW_PANEL_DEFAULT_WIDTH);
  });

  test("tab ids are safe as webview labels", () => {
    const id = generatePreviewTabId();
    expect(/^[A-Za-z0-9_-]+$/.test(id)).toBe(true);
  });
});
