import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExistingPathInsideWorkspace,
  canonicalizeWorkspaceRoot,
  ForbiddenWorkspaceRootError,
  getForbiddenWorkspaceRoots,
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

describe("forbidden workspace roots", () => {
  test("deny-list covers the standard sensitive locations", () => {
    const denyList = getForbiddenWorkspaceRoots("/Users/test");
    expect(denyList.includes("/")).toBe(true);
    expect(denyList.includes("/etc")).toBe(true);
    expect(denyList.includes("/private/etc")).toBe(true);
    expect(denyList.includes("/usr")).toBe(true);
    expect(denyList.includes("/Users/test")).toBe(true);
    expect(denyList.includes("/Users/test/.ssh")).toBe(true);
    expect(denyList.includes("/Users/test/Library/Keychains")).toBe(true);
  });

  test("canonicalizeWorkspaceRoot rejects /etc", async () => {
    let threw = false;
    try {
      await canonicalizeWorkspaceRoot("/etc");
    } catch (error) {
      threw = error instanceof ForbiddenWorkspaceRootError;
    }
    expect(threw).toBe(true);
  });

  test("canonicalizeWorkspaceRoot rejects the user's home directory", async () => {
    const home = os.homedir();
    let threw = false;
    try {
      await canonicalizeWorkspaceRoot(home);
    } catch (error) {
      threw = error instanceof ForbiddenWorkspaceRootError;
    }
    expect(threw).toBe(true);
  });

  test("canonicalizeWorkspaceRoot accepts a normal mkdtemp directory", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openhorn-ok-"));
    const real = await canonicalizeWorkspaceRoot(root);
    expect(typeof real).toBe("string");
    expect(real.length > 0).toBe(true);
  });
});
