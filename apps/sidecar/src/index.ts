import {
  buildErrorResponse,
  buildEvent,
  buildOkResponse,
  parseIncomingJsonMessage,
  validateMethodParams,
  type WsRequest,
} from './protocol';
import { canonicalizeWorkspaceRoot } from './workspace';
import { fsList, fsReadText, fsWriteText } from './fs';

type ConnectionState = {
  authed: boolean;
  workspaceRoot: string | null;
};

function getEnv(name: string): string | null {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v : null;
}

const HANDSHAKE_TOKEN = getEnv('OPENHORN_HANDSHAKE_TOKEN');
if (!HANDSHAKE_TOKEN) {
  console.error('OPENHORN_HANDSHAKE_TOKEN is required');
  process.exit(1);
}

const HOST = getEnv('OPENHORN_HOST') ?? '127.0.0.1';
const PORT = Number.parseInt(getEnv('OPENHORN_PORT') ?? '0', 10);

function decodeMessage(message: string | ArrayBuffer | Buffer) {
  if (typeof message === 'string') return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(message);
}

const server = Bun.serve({
  hostname: HOST,
  port: Number.isFinite(PORT) ? PORT : 0,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response('OpenHorn sidecar', { status: 200 });
  },
  websocket: {
    open(ws) {
      (ws as any).state = { authed: false, workspaceRoot: null } satisfies ConnectionState;
      ws.send(JSON.stringify(buildEvent('server.ready')));
    },
    message(ws, message) {
      const raw = decodeMessage(message as any);
      let request: WsRequest;
      try {
        const msg = parseIncomingJsonMessage(raw);
        if (msg.type !== 'request') return;
        request = msg;
      } catch (error) {
        ws.send(JSON.stringify(buildEvent('protocol.error', {
          error: error instanceof Error ? error.message : 'Invalid message',
        })));
        return;
      }

      void onRequest(ws, request);
    },
  },
});

async function onRequest(ws: import('bun').ServerWebSocket<unknown>, request: WsRequest) {
  const state = (ws as any).state as ConnectionState;

  try {
    if (request.method === 'auth.handshake') {
      const { token } = validateMethodParams(request.method, request.params) as { token: string };
      if (token !== HANDSHAKE_TOKEN) {
        ws.send(JSON.stringify(buildErrorResponse(request.requestId, 'Unauthorized')));
        ws.close(1008, 'Unauthorized');
        return;
      }
      state.authed = true;
      ws.send(JSON.stringify(buildOkResponse(request.requestId, { ok: true })));
      return;
    }

    if (!state.authed) {
      ws.send(JSON.stringify(buildErrorResponse(request.requestId, 'Unauthorized')));
      return;
    }

    const params = validateMethodParams(request.method, request.params);

    switch (request.method) {
      case 'workspace.setCurrent': {
        const root = (params as any).root as string;
        state.workspaceRoot = await canonicalizeWorkspaceRoot(root);
        ws.send(JSON.stringify(buildOkResponse(request.requestId, { workspaceRoot: state.workspaceRoot })));
        return;
      }
      case 'fs.list': {
        if (!state.workspaceRoot) throw new Error('Workspace not set');
        const { dir } = params as { dir: string };
        const result = await fsList({ workspaceRoot: state.workspaceRoot, dir });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      case 'fs.read': {
        if (!state.workspaceRoot) throw new Error('Workspace not set');
        const { path: filePath } = params as { path: string };
        const result = await fsReadText({ workspaceRoot: state.workspaceRoot, filePath });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      case 'fs.write': {
        if (!state.workspaceRoot) throw new Error('Workspace not set');
        const { path: filePath, content } = params as { path: string; content: string };
        const result = await fsWriteText({ workspaceRoot: state.workspaceRoot, filePath, content });
        ws.send(JSON.stringify(buildOkResponse(request.requestId, result)));
        return;
      }
      default:
        ws.send(JSON.stringify(buildErrorResponse(request.requestId, `Unknown method: ${request.method}`)));
    }
  } catch (error) {
    ws.send(JSON.stringify(buildErrorResponse(
      request.requestId,
      error instanceof Error ? error.message : 'Error'
    )));
  }
}

console.log(JSON.stringify({
  type: 'ready',
  host: HOST,
  port: server.port,
}));

