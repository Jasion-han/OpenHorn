import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExistingPathInsideWorkspace,
  canonicalizeWorkspaceRoot,
  resolvePathInsideWorkspace,
} from "./workspace";

describe("workspace path safety", () => {
  test("rejects absolute path", async () => {
    const workspaceRoot = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    expect(() =>
      resolvePathInsideWorkspace({ workspaceRoot, targetPath: "/etc/passwd" }),
    ).toThrow();
  });

  test("rejects .. traversal escape", async () => {
    const workspaceRoot = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    expect(() => resolvePathInsideWorkspace({ workspaceRoot, targetPath: "../nope" })).toThrow();
  });

  test("allows relative path inside root", async () => {
    const workspaceRoot = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    mkdirSync(path.join(workspaceRoot, "src"));
    writeFileSync(path.join(workspaceRoot, "src", "a.txt"), "hi");

    const resolved = resolvePathInsideWorkspace({ workspaceRoot, targetPath: "src/a.txt" });
    await assertExistingPathInsideWorkspace({ workspaceRoot, resolvedPath: resolved });
    expect(resolved.endsWith(path.join("src", "a.txt"))).toBe(true);
  });
});
