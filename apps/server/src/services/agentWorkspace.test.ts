import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAgentWorkingDirectory } from "./agentWorkspace";

test("resolveAgentWorkingDirectory prefers the nearest repo-like root", () => {
  const root = mkdtempSync(join(tmpdir(), "openhorn-agent-workspace-"));
  const nested = join(root, "apps", "server", "src");

  mkdirSync(nested, { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "README.md"), "# Test");

  try {
    expect(resolveAgentWorkingDirectory({ startDir: nested })).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAgentWorkingDirectory falls back to the starting directory when no better root exists", () => {
  const root = mkdtempSync(join(tmpdir(), "openhorn-agent-workspace-"));
  const nested = join(root, "scratch", "child");

  mkdirSync(nested, { recursive: true });

  try {
    expect(resolveAgentWorkingDirectory({ startDir: nested })).toBe(nested);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
