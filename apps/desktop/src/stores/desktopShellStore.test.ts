import { describe, expect, test } from "bun:test";
import { createDesktopShellStore } from "./desktopShellStore";

describe("desktop shell store", () => {
  test("fullAccessEnabled defaults to false", () => {
    const store = createDesktopShellStore();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });

  test("toggleFullAccess flips fullAccessEnabled", () => {
    const store = createDesktopShellStore();

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(true);

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });

  test("reset restores fullAccessEnabled to false", () => {
    const store = createDesktopShellStore();

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(true);

    store.getState().reset();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });
});
