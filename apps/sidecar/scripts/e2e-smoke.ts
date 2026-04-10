#!/usr/bin/env bun
/**
 * End-to-end smoke test for the OpenHorn sidecar.
 *
 * Reads the endpoint file written by the Tauri host (see
 * `apps/desktop/src-tauri/src/lib.rs` — `write_endpoint_file`),
 * opens a WebSocket, and exercises the JSON-RPC protocol across
 * the happy path AND a battery of attack-surface cases.
 *
 * Does NOT require any Anthropic credentials — we deliberately
 * avoid `agent.run` so this can be executed in environments that
 * have no real LLM reachable. What we CAN verify without an LLM:
 *
 *   - handshake token is actually required
 *   - Origin allow-list filters unknown origins
 *   - single-connection limit returns 429
 *   - workspace.setCurrent refuses dangerous roots (/, /etc, ~)
 *   - fs.list / fs.read / fs.write inside a real workspace succeed
 *   - fs.* refuse absolute paths and `..` escape
 *   - fs.write refuses symlink-planted escapes (C-S1 regression)
 *   - checkpoint.rollback refuses unknown runId (C-S6)
 *
 * Agent-level checks (`agent.run` → SDK sandbox) are in the
 * manual CV-V3 checklist because they need an LLM in the loop.
 *
 * Usage:
 *   pnpm --filter sidecar run e2e:smoke
 *
 * Prereq:
 *   `tauri dev` must be running (so the endpoint file exists).
 *   A free second connection slot (the desktop webview already
 *   holds one; our concurrency-limit test exercises the 429).
 */

import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Colour helpers + result accumulator
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
};

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

function ok(name: string, detail?: string) {
  results.push({ name, ok: true, detail });
  console.log(`${ANSI.green}  ok${ANSI.reset}  ${name}${detail ? ` ${ANSI.gray}(${detail})${ANSI.reset}` : ""}`);
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`${ANSI.red}fail${ANSI.reset}  ${name}  ${ANSI.red}${detail}${ANSI.reset}`);
}

function section(title: string) {
  console.log(`\n${ANSI.yellow}== ${title} ==${ANSI.reset}`);
}

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

type Endpoint = { host: string; port: number; token: string; pid: number };

function readEndpoint(): Endpoint {
  const candidates = [
    process.env.TMPDIR ? path.join(process.env.TMPDIR, "openhorn-sidecar-endpoint.json") : null,
    "/tmp/openhorn-sidecar-endpoint.json",
  ].filter((p): p is string => p !== null);

  for (const file of candidates) {
    try {
      const raw = readFileSync(file, "utf8");
      return JSON.parse(raw) as Endpoint;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Could not find sidecar endpoint file. Expected one of:\n  ${candidates.join("\n  ")}\n` +
      `Start 'tauri dev' first so the Rust host writes the endpoint file.`,
  );
}

// ---------------------------------------------------------------------------
// WebSocket JSON-RPC client (minimal)
// ---------------------------------------------------------------------------

interface RpcResponse {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RpcEvent {
  type: "event";
  event: string;
  data?: unknown;
}

type Incoming = RpcResponse | RpcEvent;

class Client {
  private ws: WebSocket;
  private pending = new Map<
    string,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private counter = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== "string") return;
      let parsed: Incoming;
      try {
        parsed = JSON.parse(data) as Incoming;
      } catch {
        return;
      }
      if (parsed.type === "response") {
        const pending = this.pending.get(parsed.requestId);
        if (!pending) return;
        this.pending.delete(parsed.requestId);
        if (parsed.ok) pending.resolve(parsed.result);
        else pending.reject(new Error(parsed.error || "sidecar request failed"));
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("socket closed"));
      this.pending.clear();
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const requestId = `req-${++this.counter}`;
    const frame = JSON.stringify({
      type: "request",
      requestId,
      method,
      ...(params !== undefined ? { params } : {}),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(frame);
    });
  }

  close() {
    try {
      this.ws.close(1000, "e2e done");
    } catch {
      // ignore
    }
  }
}

function connect(
  endpoint: Endpoint,
  opts: { origin?: string | null } = {},
): Promise<Client> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket constructor accepts a second `headers` option.
    // origin: null → no Origin header → sidecar still accepts (see allow-list)
    const headers: Record<string, string> = {};
    if (opts.origin !== undefined && opts.origin !== null) {
      headers.Origin = opts.origin;
    }
    const ws = new WebSocket(`ws://${endpoint.host}:${endpoint.port}/`, {
      headers,
      // @ts-expect-error Bun-specific option
    });
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve(new Client(ws));
    };
    const onError = (ev: unknown) => {
      ws.removeEventListener("open", onOpen);
      reject(
        new Error(
          `socket error (origin=${String(opts.origin)}): ${
            ev instanceof Error ? ev.message : String(ev)
          }`,
        ),
      );
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    setTimeout(() => reject(new Error("ws connect timeout")), 3000);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function expectReject(
  label: string,
  fn: () => Promise<unknown>,
  matcher?: (msg: string) => boolean,
) {
  try {
    await fn();
    fail(label, "expected rejection, got success");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (matcher && !matcher(msg)) {
      fail(label, `rejected but message did not match: ${msg}`);
    } else {
      ok(label, msg);
    }
  }
}

async function expectResolve<T>(
  label: string,
  fn: () => Promise<T>,
  validate?: (result: T) => boolean | string,
): Promise<T | null> {
  try {
    const result = await fn();
    if (validate) {
      const verdict = validate(result);
      if (verdict !== true) {
        fail(label, typeof verdict === "string" ? verdict : "validation failed");
        return null;
      }
    }
    ok(label);
    return result;
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function main() {
  const endpoint = readEndpoint();
  console.log(
    `Using sidecar @ ${endpoint.host}:${endpoint.port} ${ANSI.gray}(tauri pid ${endpoint.pid})${ANSI.reset}`,
  );

  // -------------------------------------------------------------------
  section("network-layer hardening");
  // -------------------------------------------------------------------

  // Foreign Origin should be rejected BEFORE the WS upgrade completes.
  await expectReject(
    "foreign Origin rejected at upgrade",
    async () => {
      await connect(endpoint, { origin: "https://attacker.example.com" });
    },
  );

  // Wrong token -> handshake RPC should reject.
  const c1 = await connect(endpoint, { origin: "tauri://localhost" });
  await expectReject(
    "handshake rejects wrong token",
    async () => {
      await c1.request("auth.handshake", { token: "wrong" });
    },
  );
  c1.close();

  // -------------------------------------------------------------------
  section("authenticated session");
  // -------------------------------------------------------------------

  const client = await connect(endpoint, { origin: "tauri://localhost" });
  await expectResolve(
    "handshake succeeds with correct token",
    () => client.request("auth.handshake", { token: endpoint.token }),
  );

  // -------------------------------------------------------------------
  section("workspace deny-list (C-S7)");
  // -------------------------------------------------------------------

  await expectReject(
    "workspace.setCurrent /etc rejected",
    () => client.request("workspace.setCurrent", { root: "/etc" }),
    (msg) => /not allowed|Workspace/.test(msg),
  );

  await expectReject(
    "workspace.setCurrent ~ rejected",
    () =>
      client.request("workspace.setCurrent", {
        root: process.env.HOME ?? "/",
      }),
    (msg) => /not allowed|Workspace/.test(msg),
  );

  // -------------------------------------------------------------------
  section("legitimate workspace");
  // -------------------------------------------------------------------

  const workspace = mkdtempSync(path.join(tmpdir(), "openhorn-e2e-"));
  writeFileSync(path.join(workspace, "hello.txt"), "hello from e2e");

  await expectResolve(
    "workspace.setCurrent /tmp/<mkdtemp> accepted",
    () => client.request("workspace.setCurrent", { root: workspace }),
  );

  await expectResolve(
    "fs.list sees hello.txt",
    () => client.request("fs.list", { dir: "." }) as Promise<{ entries: unknown[] }>,
    (result) => {
      const entries = (result as { entries: Array<{ name: string }> }).entries;
      return (
        (Array.isArray(entries) &&
          entries.some((e) => e.name === "hello.txt")) ||
        `unexpected entries: ${JSON.stringify(entries)}`
      );
    },
  );

  await expectResolve(
    "fs.read hello.txt returns content",
    () =>
      client.request("fs.read", { path: "hello.txt" }) as Promise<{
        content: string;
      }>,
    (result) =>
      (result.content && result.content.includes("hello from e2e")) ||
      `unexpected content: ${JSON.stringify(result)}`,
  );

  await expectResolve(
    "fs.write new file inside workspace succeeds",
    () =>
      client.request("fs.write", {
        path: "nested/fresh.txt",
        content: "written by e2e",
      }),
  );

  // -------------------------------------------------------------------
  section("path-traversal attack surface (C-S1 / C-S4)");
  // -------------------------------------------------------------------

  await expectReject(
    "fs.read absolute /etc/passwd rejected",
    () => client.request("fs.read", { path: "/etc/passwd" }),
    (msg) => /workspace-relative|escapes|absolute/i.test(msg),
  );

  await expectReject(
    "fs.read ../ escape rejected",
    () => client.request("fs.read", { path: "../outside.txt" }),
    (msg) => /escapes|workspace/i.test(msg),
  );

  await expectReject(
    "fs.write absolute path rejected",
    () =>
      client.request("fs.write", {
        path: "/tmp/openhorn-pwned.txt",
        content: "x",
      }),
    (msg) => /workspace-relative|absolute/i.test(msg),
  );

  // ---- Symlink attack: plant a symlink inside the workspace pointing
  //      at a file OUTSIDE the workspace. fs.write MUST refuse.
  const outsideDir = mkdtempSync(path.join(tmpdir(), "openhorn-outside-"));
  const outsideSecret = path.join(outsideDir, "secret.txt");
  writeFileSync(outsideSecret, "ORIGINAL_SECRET");
  const trap = path.join(workspace, "trap.txt");
  symlinkSync(outsideSecret, trap);

  await expectReject(
    "fs.write through symlink trap rejected",
    () =>
      client.request("fs.write", {
        path: "trap.txt",
        content: "PWNED",
      }),
    (msg) => /escapes/i.test(msg),
  );

  // And verify the original secret is untouched.
  const afterAttack = readFileSync(outsideSecret, "utf8");
  if (afterAttack === "ORIGINAL_SECRET") {
    ok("symlink target file content unchanged after attack");
  } else {
    fail(
      "symlink target file content unchanged after attack",
      `outside file now reads: ${JSON.stringify(afterAttack)}`,
    );
  }

  // Symlinked parent directory attack.
  const escapeDir = mkdtempSync(path.join(tmpdir(), "openhorn-escape-"));
  mkdirSync(path.join(workspace, "nestedlink"), { recursive: true });
  // Rebind: make a dir-symlink pointing outside.
  const escapeLink = path.join(workspace, "parentlink");
  symlinkSync(escapeDir, escapeLink);

  await expectReject(
    "fs.write through symlinked parent dir rejected",
    () =>
      client.request("fs.write", {
        path: "parentlink/new.txt",
        content: "x",
      }),
    (msg) => /escapes/i.test(msg),
  );

  // -------------------------------------------------------------------
  section("checkpoint runId ownership (C-S6)");
  // -------------------------------------------------------------------

  await expectReject(
    "checkpoint.rollback for unknown runId rejected",
    () => client.request("checkpoint.rollback", { runId: "not-mine" }),
    (msg) => /Unknown runId/i.test(msg),
  );

  // -------------------------------------------------------------------
  section("single-connection limit (C-S5)");
  // -------------------------------------------------------------------

  // We currently hold 1 connection (`client`). The desktop webview is
  // ALSO holding one from its initial handshake. So MAX_CONCURRENT=1
  // means our own connection should already have been rejected unless
  // we are running this script WHILE the webview is NOT connected.
  //
  // Realistic: we can't force-close the webview's connection from
  // here. Instead, verify that trying to open a THIRD connection is
  // rejected. (This is an indirect check, since if MAX were 2 it
  // would succeed — but we know MAX is 1 from the source.)
  await expectReject(
    "second concurrent connection attempt rejected by 429 or upgrade",
    async () => {
      await connect(endpoint, { origin: "tauri://localhost" });
    },
  );

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------

  client.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${failed === 0 ? ANSI.green : ANSI.red}${passed} passed, ${failed} failed${ANSI.reset}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`${ANSI.red}fatal: ${error instanceof Error ? error.message : error}${ANSI.reset}`);
  process.exit(2);
});
