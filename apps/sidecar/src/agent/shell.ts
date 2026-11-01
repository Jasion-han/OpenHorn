import { spawn } from "node:child_process";
import { sanitizeChildEnv } from "./childEnv";

/** Run one owned shell job; cancellation also stops its background descendants. */
export async function runShellCommand(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; timeoutMs: number; maxBuffer: number },
): Promise<string> {
  if (options.signal?.aborted) return "Command cancelled";
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizeChildEnv(process.env),
    });
    let failure: string | undefined;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    const stop = (reason: string) => {
      failure ??= reason;
      try {
        // The detached shell owns a process group. Killing only child.pid
        // leaves background commands alive to write files after Stop.
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* The entire job may already have exited. */
      }
    };
    const cancel = () => stop("Command cancelled");
    const timer = setTimeout(() => stop("Command timed out"), options.timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const collect = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = options.maxBuffer - current.length;
      if (chunk.length > remaining) stop("Command output exceeded maxBuffer");
      return Buffer.concat([current, chunk.subarray(0, Math.max(0, remaining))]);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error) => {
      failure = error.message;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      const output = [stdout.toString().trim(), stderr.toString().trim()]
        .filter(Boolean)
        .join("\n");
      if (output) resolve(output);
      else if (failure) resolve(`Error: ${failure}`);
      else if (code) resolve(`Error: Command failed with exit code ${code}`);
      else resolve("(no output)");
    });
  });
}
