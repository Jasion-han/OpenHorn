#!/usr/bin/env bun
/** Run the protocol smoke suite against an owned sidecar, without a desktop or LLM. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sidecarRoot = path.resolve(import.meta.dir, "..");
const smokeDirectory = mkdtempSync(path.join(tmpdir(), "openhorn-isolated-smoke-"));
const token = crypto.randomUUID();

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function stopProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(child.exited, 2000, "Child shutdown");
  } catch {
    child.kill("SIGKILL");
    await withTimeout(child.exited, 2000, "Forced child shutdown");
  }
}

const sidecar = Bun.spawn([process.execPath, "run", path.join(sidecarRoot, "src/index.ts")], {
  cwd: sidecarRoot,
  env: {
    ...process.env,
    TMPDIR: smokeDirectory,
    OPENHORN_HANDSHAKE_TOKEN: token,
    OPENHORN_HOST: "127.0.0.1",
    OPENHORN_PORT: "0",
    OPENHORN_PARENT_WATCH: "0",
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});

let renderer: WebSocket | undefined;
let smoke: ReturnType<typeof Bun.spawn> | undefined;
let announceReady: ((port: number) => void) | undefined;
let failReadiness: ((error: Error) => void) | undefined;
const ready = new Promise<number>((resolve, reject) => {
  announceReady = resolve;
  failReadiness = reject;
});
const stderrDrained = new Response(sidecar.stderr).text().catch(() => "");
const stdoutDrained = (async () => {
  const reader = sidecar.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (
            message.type === "ready" &&
            Number.isInteger(message.port) &&
            message.port > 0 &&
            message.port <= 65535
          ) {
            announceReady?.(message.port);
          }
        } catch {
          // Other stdout lines are diagnostics, not readiness announcements.
        }
      }
    }
    failReadiness?.(new Error("Owned sidecar exited before readiness"));
  } catch {
    failReadiness?.(new Error("Could not read owned sidecar readiness"));
  }
})();

try {
  const port = await withTimeout(ready, 15_000, "Sidecar readiness");
  renderer = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { Origin: "tauri://localhost" },
  });
  const socket = renderer;
  // Hold the first slot exactly as the desktop does. The existing smoke suite
  // uses the second and verifies a third connection is rejected.
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener(
        "open",
        () =>
          socket.send(
            JSON.stringify({
              type: "request",
              requestId: "isolated-renderer-auth",
              method: "auth.handshake",
              params: { token },
            }),
          ),
        { once: true },
      );
      socket.addEventListener("error", () => reject(new Error("Owned renderer socket failed")), {
        once: true,
      });
      socket.addEventListener("close", () => reject(new Error("Owned renderer socket closed")), {
        once: true,
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.requestId !== "isolated-renderer-auth") return;
          if (message.ok) resolve();
          else reject(new Error("Owned renderer authentication failed"));
        } catch {
          reject(new Error("Invalid owned renderer response"));
        }
      });
    }),
    5000,
    "Renderer handshake",
  );
  writeFileSync(
    path.join(smokeDirectory, "openhorn-sidecar-endpoint.json"),
    JSON.stringify({ host: "127.0.0.1", port, token, pid: sidecar.pid }),
    { mode: 0o600 },
  );
  smoke = Bun.spawn([process.execPath, "run", path.join(sidecarRoot, "scripts/e2e-smoke.ts")], {
    cwd: sidecarRoot,
    env: { ...process.env, TMPDIR: smokeDirectory },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await withTimeout(smoke.exited, 60_000, "Protocol smoke suite");
} finally {
  try {
    try {
      if (smoke) await stopProcess(smoke);
    } finally {
      renderer?.close();
      await stopProcess(sidecar);
      await Promise.all([stdoutDrained, stderrDrained]);
    }
  } finally {
    rmSync(smokeDirectory, { recursive: true, force: true });
  }
}
