import { describe, expect, test } from "bun:test";
import {
  normalizeAddressInput,
  previewTabIdFromLabel,
  previewWebviewLabel,
} from "./previewWebview";

describe("previewWebview helpers", () => {
  test("label round-trips the tab id", () => {
    expect(previewWebviewLabel("abc-1")).toBe("preview-abc-1");
    expect(previewTabIdFromLabel("preview-abc-1")).toBe("abc-1");
    expect(previewTabIdFromLabel("main")).toBe(null);
  });

  test("address input gets https:// when no scheme is given", () => {
    expect(normalizeAddressInput("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeAddressInput("  http://localhost:3000 ")).toBe("http://localhost:3000/");
    expect(normalizeAddressInput("localhost:3000/x")).toBe("https://localhost:3000/x");
  });

  test("address input rejects empty, unparsable and non-http values", () => {
    expect(normalizeAddressInput("")).toBe(null);
    expect(normalizeAddressInput("   ")).toBe(null);
    expect(normalizeAddressInput("javascript:alert(1)")).toBe(null);
    expect(normalizeAddressInput("file:///etc/passwd")).toBe(null);
  });
});
