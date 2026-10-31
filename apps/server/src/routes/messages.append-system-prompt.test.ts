import { afterAll, expect, mock, test } from "bun:test";
// `mock.module()` is process-global and cannot be unregistered. Snapshot the real
// modules at evaluation time and re-register them in afterAll so these mocks do not
// leak into later test files (see channelService.agent-check-baseurl.test.ts).
import * as realMessageServiceNs from "../services/messageService";
import * as realRequestUserNs from "../utils/requestUser";

const realMessageService = { ...realMessageServiceNs };
const realRequestUser = { ...realRequestUserNs };

afterAll(() => {
  mock.module("../services/messageService", () => realMessageService);
  mock.module("../utils/requestUser", () => realRequestUser);
});

type Call = { fn: string; args: unknown[] };

async function loadRoutes() {
  const calls: Call[] = [];
  const emptyStream = () => new ReadableStream({ start: (controller) => controller.close() });
  mock.module("../utils/requestUser", () => ({
    ...realRequestUser,
    requireUser: async (
      c: { set: (key: string, value: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("user", { id: "user-1", email: "u@example.com", username: "u" });
      return next();
    },
  }));
  mock.module("../services/messageService", () => ({
    ...realMessageService,
    regenerateMessage: async (...args: unknown[]) => {
      calls.push({ fn: "regenerate", args });
      return emptyStream();
    },
    editUserMessage: async (...args: unknown[]) => {
      calls.push({ fn: "edit", args });
      return emptyStream();
    },
  }));
  const mod = await import(`./messages?append-system-prompt=${crypto.randomUUID()}`);
  return {
    routes: mod.default as { request: (path: string, init: RequestInit) => Response },
    calls,
  };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("regenerate rejects an over-long appendSystemPrompt with 400", async () => {
  const { routes, calls } = await loadRoutes();
  const res = await routes.request(
    "/m-1/regenerate",
    post({ appendSystemPrompt: "a".repeat(32_001) }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "appendSystemPrompt is too long" });
  expect(calls).toHaveLength(0);
});

test("edit rejects an over-long appendSystemPrompt with 400", async () => {
  const { routes, calls } = await loadRoutes();
  const res = await routes.request(
    "/m-1/edit",
    post({ content: "hi", appendSystemPrompt: "a".repeat(32_001) }),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "appendSystemPrompt is too long" });
  expect(calls).toHaveLength(0);
});

test("regenerate forwards a valid appendSystemPrompt and ignores non-strings", async () => {
  const { routes, calls } = await loadRoutes();
  const ok = await routes.request("/m-1/regenerate", post({ appendSystemPrompt: " GENUI " }));
  expect(ok.status).toBe(200);
  const ignored = await routes.request("/m-2/regenerate", post({ appendSystemPrompt: 123 }));
  expect(ignored.status).toBe(200);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.args[2]).toMatchObject({ appendSystemPrompt: "GENUI" });
  expect((calls[1]?.args[2] as { appendSystemPrompt?: string }).appendSystemPrompt).toBe(undefined);
});

test("edit forwards a valid appendSystemPrompt and ignores blank values", async () => {
  const { routes, calls } = await loadRoutes();
  const ok = await routes.request(
    "/m-1/edit",
    post({ content: "hi", appendSystemPrompt: "GENUI" }),
  );
  expect(ok.status).toBe(200);
  const ignored = await routes.request(
    "/m-2/edit",
    post({ content: "hi", appendSystemPrompt: "  " }),
  );
  expect(ignored.status).toBe(200);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.args).toEqual(["user-1", "m-1", "hi", { appendSystemPrompt: "GENUI" }]);
  expect(calls[1]?.args).toEqual(["user-1", "m-2", "hi", { appendSystemPrompt: undefined }]);
});
