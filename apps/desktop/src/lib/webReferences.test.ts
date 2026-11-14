import { expect, test } from "bun:test";
import { safeWebReference } from "./webReferences";

test("web citations accept HTTP URLs without upgrading unsafe schemes or leaking user info", () => {
  expect(safeWebReference("https://example.com/source?q=1#part")).toBe(
    "https://example.com/source?q=1#part",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///etc/hosts",
    "https://user:synthetic@example.com/",
    "not a url",
    "",
  ]) {
    expect(safeWebReference(value)).toBe(null);
  }
});
