import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

const SIDECAR_ENTRY = path.join(import.meta.dir, "index.ts");

type StartedSidecar = {
  port: number;
  token: string;
  kill: () => void;
};

async function startSidecar(envOverrides: Record<string, string> = {}): Promise<StartedSidecar> {
  const token = `test-token-${Math.random().toString(36).slice(2)}`;
  const child = spawn(
    process.execPath, // bun
    ["run", SIDECAR_ENTRY],
    {
      env: {
        ...process.env,
        OPENHORN_HANDSHAKE_TOKEN: token,
        OPENHORN_HOST: "127.0.0.1",
        OPENHORN_PORT: "0",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/"port"\s*:\s*(\d+)/);
      if (match?.[1]) {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        resolve(Number.parseInt(match[1], 10));
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      reject(new Error(`sidecar exited early code=${code}\nstdout=${stdout}\nstderr=${stderr}`));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);

    setTimeout(() => {
      reject(new Error(`sidecar did not announce port within 5s\nstdout=${stdout}\nstderr=${stderr}`));
    }, 5000);
  });

  return {
    port,
    token,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    },
  };
}

describe("sidecar network hardening", () => {
  test("refuses to start when OPENHORN_HOST is not loopback", async () => {
    const child = spawn(
      process.execPath,
      ["run", SIDECAR_ENTRY],
      {
        env: {
          ...process.env,
          OPENHORN_HANDSHAKE_TOKEN: "x",
          OPENHORN_HOST: "0.0.0.0",
          OPENHORN_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const exitCode: number = await new Promise((resolve) => {
      child.once("exit", (code) => resolve(code ?? -1));
    });

    expect(exitCode).not.toBe(0);
  });

  test("rejects WebSocket upgrade with a foreign Origin", async () => {
    const sidecar = await startSidecar();
    try {
      const response = await fetch(`http://127.0.0.1:${sidecar.port}/`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          Origin: "https://attacker.example.com",
        },
      });
      expect(response.status).toBe(403);
    } finally {
      sidecar.kill();
    }
  });

  test("accepts upgrade with a tauri:// Origin", async () => {
    const sidecar = await startSidecar();
    try {
      // We can't easily complete a WS handshake from a unit test, but we
      // can verify the fetch handler does not 403/429 the request before
      // it reaches Bun's upgrade machinery. Bun returns 200 for the
      // fallback Response when upgrade fails (because we're using fetch
      // not a WS client), which is fine — what matters is the 403 we
      // returned in the previous test came from our origin check, and
      // here we should NOT see 403.
      const response = await fetch(`http://127.0.0.1:${sidecar.port}/`, {
        headers: {
          Origin: "tauri://localhost",
        },
      });
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(429);
    } finally {
      sidecar.kill();
    }
  });

  test("rejects connections beyond the single-connection limit", async () => {
    const sidecar = await startSidecar();
    try {
      // Open one real WebSocket; while it's alive any subsequent upgrade
      // attempt should be rejected with 429.
      const ws = new WebSocket(`ws://127.0.0.1:${sidecar.port}/`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
        setTimeout(() => reject(new Error("ws open timeout")), 3000);
      });

      try {
        const response = await fetch(`http://127.0.0.1:${sidecar.port}/`, {
          headers: {
            Origin: "tauri://localhost",
          },
        });
        expect(response.status).toBe(429);
      } finally {
        ws.close();
        // Give the server a tick to process the close so subsequent tests
        // (if any reuse this sidecar) can reconnect.
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      sidecar.kill();
    }
  });
});
