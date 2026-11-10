import { expect, test } from "bun:test";
import { compareVersions } from "./versionDiff";

test("line comparison reconstructs both texts, including repeated lines and final newlines", () => {
  for (const [before, after] of [
    ["a\nb\na\n", "a\nc\na\n"],
    ["", "text"],
    ["a\r\n", "a\n"],
    ["<script>unsafe</script>", "other"],
  ]) {
    const diff = compareVersions(before, after);
    if (diff.same || diff.mode !== "lines") throw new Error("Expected bounded line comparison");
    expect(
      diff.lines
        .filter((line) => line.kind !== "added")
        .map((line) => line.text)
        .join("\n"),
    ).toBe(before);
    expect(
      diff.lines
        .filter((line) => line.kind !== "removed")
        .map((line) => line.text)
        .join("\n"),
    ).toBe(after);
  }
});
test("large comparisons degrade within bounds without claiming different text is identical", () => {
  expect(compareVersions("same", "same")).toEqual({ same: true });
  const diff = compareVersions("a".repeat(100_001), `${"a".repeat(100_000)}b`);
  if (diff.same || diff.mode !== "separate") throw new Error("Expected separate text view");
  expect(diff.before.length).toBe(100_000);
  expect(diff.truncated).toBe(true);
});
