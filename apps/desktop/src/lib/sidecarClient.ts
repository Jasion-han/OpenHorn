type WsRequest = {
  type: "request";
  requestId: string;
  method: string;
  params?: unknown;
};

type WsResponse = {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type WsEvent = {
  type: "event";
  event: string;
  data?: unknown;
};

type IncomingMessage = WsResponse | WsEvent;

export class SidecarClient {
  private ws: WebSocket;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private listeners = new Map<string, Set<(data: unknown) => void>>();

  constructor(private input: { wsUrl: string; token: string }) {
    this.ws = new WebSocket(input.wsUrl);
    this.ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(event.data) as IncomingMessage;
      } catch {
        return;
      }

      if (msg.type === "response") {
        const handler = this.pending.get(msg.requestId);
        if (!handler) return;
        this.pending.delete(msg.requestId);
        if (msg.ok) handler.resolve(msg.result);
        else handler.reject(new Error(msg.error || "Request failed"));
        return;
      }

      if (msg.type === "event") {
        const set = this.listeners.get(msg.event);
        if (set) {
          for (const cb of set) cb(msg.data);
        }
        const any = this.listeners.get("*");
        if (any) {
          for (const cb of any) cb({ event: msg.event, data: msg.data });
        }
      }
    });

    this.ws.addEventListener("close", () => {
      for (const [id, handler] of this.pending.entries()) {
        this.pending.delete(id);
        handler.reject(new Error(`WebSocket closed (pending request ${id})`));
      }
    });
  }

  async connect(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      await this.handshake();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });

    await this.handshake();
  }

  private async handshake() {
    await this.request("auth.handshake", { token: this.input.token });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const requestId = crypto.randomUUID();
    const payload: WsRequest = { type: "request", requestId, method, params };
    const json = JSON.stringify(payload);

    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws.send(json);
    });
  }

  on(event: string, cb: (data: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => {
      const s = this.listeners.get(event);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(event);
    };
  }
}
