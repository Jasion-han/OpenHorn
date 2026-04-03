import { expect, test } from "bun:test";
import { executeBashTool, formatBashToolResult } from "./bashToolExecutor";

test("executeBashTool runs a successful command", async () => {
  const result = await executeBashTool({
    command: "printf 'hello'",
    cwd: process.cwd(),
  });

  expect(result.success).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("hello");
  expect(result.stderr).toBe("");
});

test("executeBashTool captures failing command output", async () => {
  const result = await executeBashTool({
    command: "echo boom >&2; exit 7",
    cwd: process.cwd(),
  });

  expect(result.success).toBe(false);
  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("boom");
});

test("executeBashTool rejects empty commands", async () => {
  await expect(
    executeBashTool({
      command: "   ",
      cwd: process.cwd(),
    }),
  ).rejects.toThrow("Bash command is required");
});

test("formatBashToolResult renders a compact summary", () => {
  expect(
    formatBashToolResult({
      command: "printf 'hello'",
      cwd: process.cwd(),
      stdout: "hello",
      stderr: "",
      exitCode: 0,
      success: true,
    }),
  ).toContain("stdout:\nhello");
});

test("formatBashToolResult truncates oversized stdout blocks", () => {
  const stdout = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");
  const formatted = formatBashToolResult({
    command: "seq",
    cwd: process.cwd(),
    stdout,
    stderr: "",
    exitCode: 0,
    success: true,
  });

  expect(formatted).toContain("line-1");
  expect(formatted).toContain("line-80");
  expect(formatted).toContain("lines omitted");
});
