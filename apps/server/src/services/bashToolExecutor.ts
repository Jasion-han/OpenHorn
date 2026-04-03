import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_OUTPUT_LINES = 40;
const OUTPUT_HEAD_LINES = 20;
const OUTPUT_TAIL_LINES = 10;
const MAX_OUTPUT_CHARS = 4_000;
const OUTPUT_HEAD_CHARS = 2_400;
const OUTPUT_TAIL_CHARS = 1_200;

export type BashToolExecutionResult = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
};

export async function executeBashTool(params: {
  command: string;
  cwd: string;
}): Promise<BashToolExecutionResult> {
  const command = params.command.trim();
  if (!command) {
    throw new Error("Bash command is required");
  }

  try {
    const result = await execFileAsync("bash", ["-lc", command], {
      cwd: params.cwd,
      env: process.env,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return {
      command,
      cwd: params.cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      success: true,
    };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      command,
      cwd: params.cwd,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : failure.message,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      success: false,
    };
  }
}

function truncateOutputBlock(value: string) {
  const normalized = value.trimEnd();
  if (!normalized) {
    return normalized;
  }

  let next = normalized;
  const lines = next.split(/\r?\n/);
  if (lines.length > MAX_OUTPUT_LINES) {
    const head = lines.slice(0, OUTPUT_HEAD_LINES);
    const tail = lines.slice(-OUTPUT_TAIL_LINES);
    const omittedLines = Math.max(0, lines.length - head.length - tail.length);
    next = [...head, `... (${omittedLines} lines omitted) ...`, ...tail].join("\n");
  }

  if (next.length > MAX_OUTPUT_CHARS) {
    const head = next.slice(0, OUTPUT_HEAD_CHARS).trimEnd();
    const tail = next.slice(-OUTPUT_TAIL_CHARS).trimStart();
    const omittedChars = Math.max(0, next.length - head.length - tail.length);
    next = `${head}\n... (${omittedChars} chars omitted) ...\n${tail}`;
  }

  return next;
}

export function formatBashToolResult(result: BashToolExecutionResult) {
  const parts = [`exit_code: ${result.exitCode}`];
  const stdout = truncateOutputBlock(result.stdout);
  const stderr = truncateOutputBlock(result.stderr);
  if (stdout.trim()) {
    parts.push(`stdout:\n${stdout}`);
  }
  if (stderr.trim()) {
    parts.push(`stderr:\n${stderr}`);
  }
  if (!stdout.trim() && !stderr.trim()) {
    parts.push("(no output)");
  }
  return parts.join("\n\n");
}
