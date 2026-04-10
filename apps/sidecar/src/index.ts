import { runClaudeAgent } from "./agent/claude";
import { createCheckpointSession, rollbackCheckpoint } from "./checkpoints";
import { fsList, fsReadText, fsWriteText } from "./fs";
import {
  buildErrorResponse,
  buildEvent,
  buildOkResponse,
  parseIncomingJsonMessage,
  validateMethodParams,
  type WsRequest,
} from "./protocol";
import { canonicalizeWorkspaceRoot } from "./workspace";

type ConnectionState = {
  authed: boolean;
  workspaceRoot: string | null;
  pendingApprovals: Map<string, (allow: boolean) => void>;
  agentRuns: Map<string, { abortController: AbortController }>;
  /**
   * Run IDs that this connection has executed (whether currently running
   * or already finalized). checkpoint.rollback is gated on this set so
   * one connection can't roll back another connection's runs even if it
   * happens to know the runId.
   */
  ownedRunIds: Set<string>;
  lastActivityAt: number;
};

const wsStates = new WeakMap<import("bun").ServerWebSocket<unknown>, ConnectionState>();
const activeConnections = new Set<import("bun").ServerWebSocket<unknown>>();

function getEnv(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v : null;
}

const HANDSHAKE_TOKEN = getEnv("OPENHORN_HANDSHAKE_TOKEN");
if (!HANDSHAKE_TOKEN) {
  console.error("OPENHORN_HANDSHAKE_TOKEN is required");
  process.exit(1);
}

// Loopback-only. We refuse to listen on a non-loopback interface even
// if OPENHORN_HOST is misconfigured. The handshake token is the second
// line of defense, but exposing the WebSocket on 0.0.0.0 would let any
// other user on the same machine try to brute-force the token, and
// would let any program on a shared LAN attempt connections too.
const REQUESTED_HOST = getEnv("OPENHORN_HOST") ?? "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(REQUESTED_HOST)) {
  console.error(
    `OPENHORN_HOST must be a loopback address (127.0.0.1, ::1, localhost); got ${REQUESTED_HOST}`,
  );
  process.exit(1);
}
const HOST = REQUESTED_HOST;
const PORT = Number.parseInt(getEnv("OPENHORN_PORT") ?? "0", 10);

// Allow-list of Origin headers we will accept on the WebSocket upgrade.
// This is the third defense layer, on top of loopback-only listen +
// handshake token: it stops a malicious web page in another tab from
// even reaching the upgrade flow.
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

// Allow 2 concurrent connections: one for the desktop webview and one
// for diagnostic tooling (E2E smoke tests, developer CLI, etc.). The
// real access gate is the handshake token, not the connection count.
const MAX_CONCURRENT_CONNECTIONS = 2;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 30 * 1000;

function decodeMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  if (message instanceof Uint8Array) return new TextDecoder().decode(message);
  return "";
}

const server = Bun.serve({
  hostname: HOST,
  port: Number.isFinite(PORT) ? PORT : 0,
  fetch(req, server) {
    // Origin check: refuse the upgrade unless the request comes from a
    // known desktop renderer or our local dev server. The token check
    // happens after the upgrade, but enforcing Origin first stops
    // browser-side attackers from even establishing a socket.
    const origin = req.headers.get("origin");
    const originIsAllowed = origin === null || ALLOWED_ORIGINS.has(origin);
    if (!originIsAllowed) {
      return new Response("Forbidden", { status: 403 });
    }

    // Single-connection limit: OpenHorn ships one desktop client per
    // sidecar process. Refusing additional sockets makes credential
    // leakage and resource exhaustion far harder.
    if (activeConnections.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too many connections", { status: 429 });
    }

    if (server.upgrade(req)) return;
    return new Response("OpenHorn sidecar", { status: 200 });
  },
  websocket: {
    open(ws) {
      wsStates.set(ws, {
        authed: false,
        workspaceRoot: null,
        pendingApprovals: new Map(),
        agentRuns: new Map(),
        ownedRunIds: new Set(),
        lastActivityAt: Date.now(),
      });
      activeConnections.add(ws);
      ws.send(JSON.stringify(buildEvent("server.ready")));
    },
    close(ws) {
      const state = wsStates.get(ws);
      if (state) {
        for (const run of state.agentRuns.values()) {
          run.abortController.abort();
        }
        state.pendingApprovals.clear();
        state.agentRuns.clear();
      }
      activeConnections.delete(ws);
    },
    message(ws, message) {
      const state = wsStates.get(ws);
      if (state) {
        state.lastActivityAt = Date.now();
      }
      const raw = decodeMessage(message);
      let request: WsRequest;
      try {
        const msg = parseIncomingJsonMessage(raw);
        if (msg.type !== "request") return;
        request = msg;
      } catch (error) {
        ws.send(
          JSON.stringify(
            buildEvent("protocol.error", {
              error: error instanceof Error ? error.message : "Invalid message",
            }),
          ),
        );
        return;
      }

      void onRequest(ws, request);
    },
  },
});

// Idle reaper: periodically close any connection that has been silent
// for longer than IDLE_TIMEOUT_MS. This prevents an abandoned client
// from holding the single allowed connection slot indefinitely.
setInterval(() => {
  const now = Date.now();
  for (const ws of activeConnections) {
    const state = wsStates.get(ws);
    if (!state) continue;
    if (now - state.lastActivityAt > IDLE_TIMEOUT_MS) {
      try {
        ws.close(1000, "Idle timeout");
      } catch {
        // ignore
      }
    }
  }
}, IDLE_CHECK_INTERVAL_MS).unref();

async function onRequest(ws: import("bun").ServerWebSocket<unknown>, request: WsRequest) {
  const state = wsStates.get(ws);
  if (!state) {
    throw new Error("Missing connection state");
  }

  try {
    if (request.method === "auth.handshake") {
      const { token } = validateMethodParams(request.method, request.params) as { token: string };
      if (token !== HANDSHAKE_TOKEN) {
        ws.send(JSON.stringify(buildErrorResponse(request.requestId, "Unauthorized")));
        ws.close(1008, "Unauthorized");
        return;
      }
      state.authed = true;
      ws.send(JSON.stringify(buildOkResponse(request.requestId, { ok: true })));
      return;
    }

    if (!state.authed) {
      ws.send(JSON.stringify(buildErrorResponse(request.requestId, "Unauthorized")));
      return;
    }

    const params = validateMethodParams(request.method, request.params);

    switch (request.method) {
      case "workspace.setCurrent": {
        const { root } = params as { root: string };
        state.workspaceRoot = await canonicalizeWorkspaceRoot(root);
        ws.send(
          JSON.stringify(
            buildOkResponse(request.requestId, { workspaceRoot: state.workspaceRoot }),
          ),
        );
        return;
      }
      case "fs.list": {
        if (!state.workspaceRoot) throw new Error("Workspace not set");
        const { dir } = params as { dir: string };
        const result = await fsList({ workspaceRoot: state.workspaceRoot, dir });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      case "fs.read": {
        if (!state.workspaceRoot) throw new Error("Workspace not set");
        const { path: filePath } = params as { path: string };
        const result = await fsReadText({ workspaceRoot: state.workspaceRoot, filePath });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      case "fs.write": {
        if (!state.workspaceRoot) throw new Error("Workspace not set");
        const { path: filePath, content } = params as { path: string; content: string };
        const result = await fsWriteText({ workspaceRoot: state.workspaceRoot, filePath, content });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      case "approvals.respond": {
        const { toolUseId, allow } = params as { toolUseId: string; allow: boolean };
        const resolver = state.pendingApprovals.get(toolUseId);
        if (!resolver) {
          ws.send(JSON.stringify(buildErrorResponse(request.requestId, "Approval not found")));
          return;
        }
        state.pendingApprovals.delete(toolUseId);
        resolver(Boolean(allow));
        ws.send(JSON.stringify(buildOkResponse(request.requestId, { ok: true })));
        return;
      }
      case "agent.run": {
        if (!state.workspaceRoot) throw new Error("Workspace not set");
        const { prompt, apiKey, model, baseUrl } = params as {
          prompt: string;
          apiKey: string;
          model: string;
          baseUrl?: string;
        };

        const abortController = new AbortController();
        const checkpoint = await createCheckpointSession(state.workspaceRoot);
        const runId = checkpoint.runId;
        state.agentRuns.set(runId, { abortController });
        state.ownedRunIds.add(runId);

        ws.send(JSON.stringify(buildOkResponse(request.requestId, { runId })));

        void runClaudeAgent({
          apiKey,
          baseUrl,
          model,
          prompt,
          cwd: state.workspaceRoot,
          abortController,
          checkpoint,
          requestApproval: async (input) => {
            ws.send(JSON.stringify(buildEvent("approval.request", { runId, ...input })));
            const decision = await new Promise<boolean>((resolve) => {
              state.pendingApprovals.set(input.toolUseId, resolve);
            });
            return decision;
          },
          onEvent: (event) => {
            ws.send(JSON.stringify(buildEvent("agent.event", { runId, event })));
          },
          onCheckpointReady: (readyRunId) => {
            ws.send(JSON.stringify(buildEvent("checkpoint.ready", { runId: readyRunId })));
          },
        }).finally(() => {
          state.agentRuns.delete(runId);
        });

        return;
      }
      case "agent.cancel": {
        const { runId } = params as { runId: string };
        const run = state.agentRuns.get(runId);
        if (!run) {
          ws.send(JSON.stringify(buildErrorResponse(request.requestId, "Run not found")));
          return;
        }
        run.abortController.abort();
        ws.send(JSON.stringify(buildOkResponse(request.requestId, { ok: true })));
        return;
      }
      case "checkpoint.rollback": {
        if (!state.workspaceRoot) throw new Error("Workspace not set");
        const { runId } = params as { runId: string };
        // Authorization: this connection must have actually executed the
        // run it's trying to roll back. Without this check any authed
        // connection that guesses or learns a runId could revert another
        // session's work.
        if (!state.ownedRunIds.has(runId)) {
          ws.send(
            JSON.stringify(
              buildErrorResponse(request.requestId, "Unknown runId for this session"),
            ),
          );
          return;
        }
        const result = await rollbackCheckpoint(state.workspaceRoot, runId);
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      default:
        ws.send(
          JSON.stringify(
            buildErrorResponse(request.requestId, `Unknown method: ${request.method}`),
          ),
        );
    }
  } catch (error) {
    ws.send(
      JSON.stringify(
        buildErrorResponse(request.requestId, error instanceof Error ? error.message : "Error"),
      ),
    );
  }
}

console.log(
  JSON.stringify({
    type: "ready",
    host: HOST,
    port: server.port,
  }),
);
