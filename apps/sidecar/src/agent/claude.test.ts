import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspaceRoot } from "../workspace";
import {
  buildNetworkAllowedDomains,
  checkSdkFsToolPath,
  DEFAULT_ANTHROPIC_HOST,
  extractHostname,
} from "./claude";

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

describe("extractHostname", () => {
  test("returns the hostname for a normal https URL", () => {
    expect(extractHostname("https://api.anthropic.com")).toBe("api.anthropic.com");
    expect(extractHostname("https://api.anthropic.com/v1/messages")).toBe("api.anthropic.com");
  });

  test("strips port and userinfo", () => {
    expect(extractHostname("http://user:pass@relay.example.com:8080/path")).toBe(
      "relay.example.com",
    );
  });

  test("returns null for invalid input", () => {
    expect(extractHostname(undefined)).toBe(null);
    expect(extractHostname("")).toBe(null);
    expect(extractHostname("not a url")).toBe(null);
  });
});

describe("buildNetworkAllowedDomains", () => {
  test("includes only the default Anthropic host when no baseUrl is provided", () => {
    const result = buildNetworkAllowedDomains(undefined);
    expect(result).toEqual([DEFAULT_ANTHROPIC_HOST]);
  });

  test("includes the user's custom host plus the default", () => {
    const result = buildNetworkAllowedDomains("https://relay.example.com/v1");
    expect(result.includes("relay.example.com")).toBe(true);
    expect(result.includes(DEFAULT_ANTHROPIC_HOST)).toBe(true);
  });

  test("does not duplicate the default host when the user URL points to it", () => {
    const result = buildNetworkAllowedDomains("https://api.anthropic.com");
    expect(result).toEqual([DEFAULT_ANTHROPIC_HOST]);
  });

  test("falls back to the default when the user URL is unparseable", () => {
    const result = buildNetworkAllowedDomains("nonsense");
    expect(result).toEqual([DEFAULT_ANTHROPIC_HOST]);
  });
});
