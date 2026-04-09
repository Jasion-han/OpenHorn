import { describe, expect, test } from "bun:test";
import { formatWorkspacePath } from "./DesktopSidecarWorkspaceBadge";

describe("formatWorkspacePath", () => {
  test("returns the path unchanged when it fits in the limit", () => {
    expect(formatWorkspacePath("/tmp/ws", 32)).toBe("/tmp/ws");
  });

  test("truncates from the left and prefixes with an ellipsis when too long", () => {
    const path = "/Users/alice/Projects/openhorn/apps/desktop/src/components";
    const result = formatWorkspacePath(path, 20);
    expect(result.length).toBe(20);
    expect(result.startsWith("…")).toBe(true);
    // The trailing directory is preserved so the user still
    // recognises the leaf of the path.
    expect(result.endsWith("components")).toBe(true);
  });

  test("uses the default max of 32 characters", () => {
    const long = "/aaa/bbb/ccc/ddd/eee/fff/ggg/hhh/iii";
    const result = formatWorkspacePath(long);
    expect(result.length <= 32).toBe(true);
  });
});
