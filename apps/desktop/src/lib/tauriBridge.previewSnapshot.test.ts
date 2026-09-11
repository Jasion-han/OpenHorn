import { describe, expect, test } from "bun:test";
import { previewWebviewSnapshot } from "./tauriBridge";

describe("previewWebviewSnapshot", () => {
  test("resolves null outside the Tauri runtime instead of rejecting", async () => {
    const result = await previewWebviewSnapshot("preview-abc");
    expect(result).toBe(null);
  });
});
