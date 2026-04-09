import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspaceRoot } from "../workspace";
import { checkSdkFsToolPath } from "./claude";

describe("checkSdkFsToolPath", () => {
  test("allows Read of a relative path inside the workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );
    writeFileSync(path.join(root, "a.txt"), "hello");

    const result = await checkSdkFsToolPath("Read", { file_path: "a.txt" }, root);
    expect(result).toBe(null);
  });

  test("allows Read of an absolute path that lives inside the workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );
    writeFileSync(path.join(root, "a.txt"), "hello");

    const result = await checkSdkFsToolPath(
      "Read",
      { file_path: path.join(root, "a.txt") },
      root,
    );
    expect(result).toBe(null);
  });

  test("denies Read of an absolute path outside the workspace", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );

    const result = await checkSdkFsToolPath(
      "Read",
      { file_path: "/etc/passwd" },
      root,
    );
    expect(result).not.toBe(null);
  });

  test("denies Read of a parent-traversal path", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );

    const result = await checkSdkFsToolPath(
      "Read",
      { file_path: "../escape.txt" },
      root,
    );
    expect(result).not.toBe(null);
  });

  test("denies Write through a planted symlink", async () => {
    const baseTemp = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-attack-")),
    );
    const root = path.join(baseTemp, "ws");
    mkdirSync(root);
    const outside = path.join(baseTemp, "outside");
    mkdirSync(outside);
    const target = path.join(outside, "secret.txt");
    writeFileSync(target, "ORIGINAL");
    symlinkSync(target, path.join(root, "trap.txt"));

    const result = await checkSdkFsToolPath(
      "Write",
      { file_path: "trap.txt" },
      root,
    );
    expect(result).not.toBe(null);
  });

  test("denies Edit through a symlinked parent directory", async () => {
    const baseTemp = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-attack-")),
    );
    const root = path.join(baseTemp, "ws");
    mkdirSync(root);
    const outside = path.join(baseTemp, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "escape"));

    const result = await checkSdkFsToolPath(
      "Edit",
      { file_path: "escape/new.txt" },
      root,
    );
    expect(result).not.toBe(null);
  });

  test("returns null for tools that have no file path (Bash is handled separately)", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );
    expect(await checkSdkFsToolPath("Grep", { pattern: "foo" }, root)).toBe(null);
    expect(await checkSdkFsToolPath("Glob", { pattern: "*.ts" }, root)).toBe(null);
  });

  test("allows Write to a new file in an existing workspace subdirectory", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-claude-")),
    );
    mkdirSync(path.join(root, "src"));

    const result = await checkSdkFsToolPath(
      "Write",
      { file_path: "src/new.ts" },
      root,
    );
    expect(result).toBe(null);
  });
});
