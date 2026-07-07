import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExistingPathInsideWorkspace,
  canonicalizeWorkspaceRoot,
  ForbiddenWorkspaceRootError,
  getForbiddenWorkspaceRoots,
  resolvePathInsideWorkspace,
  writeFileNoFollow,
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

describe("writeFileNoFollow", () => {
  test("writes a new regular file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-nf-"));
    const target = path.join(dir, "new.txt");
    await writeFileNoFollow(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("overwrites an existing regular file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-nf-"));
    const target = path.join(dir, "a.txt");
    writeFileSync(target, "old");
    await writeFileNoFollow(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  test("refuses to follow a terminal symlink (TOCTOU guard)", async () => {
    // Simulates a symlink swapped in as the final component after the
    // workspace-boundary check: the write must fail rather than escape.
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-nf-"));
    const outside = path.join(dir, "secret.txt");
    writeFileSync(outside, "ORIGINAL_SECRET");
    const link = path.join(dir, "trap.txt");
    symlinkSync(outside, link);

    let threw = false;
    try {
      await writeFileNoFollow(link, "PWNED");
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("ORIGINAL_SECRET");
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
