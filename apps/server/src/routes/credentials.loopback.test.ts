import { afterAll, expect, mock, test } from "bun:test";
// `import * as` namespaces are LIVE — snapshot the real modules before any
// in-test `mock.module(...)` runs, then re-register them in afterAll so this
// file's mocks don't leak into later test files (mock.restore() does not
// unregister mock.module()).
import * as realAuthServiceNs from "../services/authService";
import * as realCredentialDetectionServiceNs from "../services/credentialDetectionService";

const realAuthService = { ...realAuthServiceNs };
const realCredentialDetectionService = { ...realCredentialDetectionServiceNs };

afterAll(() => {
  mock.module("../services/authService", () => realAuthService);
  mock.module("../services/credentialDetectionService", () => realCredentialDetectionService);
});

// requireUser resolves the request user via getUserFromToken — mock it so the
// route authenticates instead of returning 401, letting us exercise the
// loopback guard.
mock.module("../services/authService", () => ({
  getUserFromToken: async () => ({ id: "user-1" }),
}));
mock.module("../services/credentialDetectionService", () => ({
  detectCredentialSources: async () => [],
  getCredential: async () => ({ apiKey: "test-key-1234567890" }),
}));

// Fake Bun server exposing requestIP() so hono/bun getConnInfo can resolve the
// peer address (Bun passes the server as fetch's 2nd arg == c.env).
function serverWithIP(address: string) {
  return { requestIP: () => ({ address, family: "IPv4", port: 51234 }) };
}

async function callKey(remoteAddress: string) {
  const { default: credentials } = await import("./credentials");
  const req = new Request("http://localhost/sources/env-openai/key", {
    headers: { Cookie: "token=fake" },
  });
  return credentials.fetch(req, serverWithIP(remoteAddress));
}

test("GET /sources/:id/key rejects a non-loopback client with 403", async () => {
  const res = await callKey("203.0.113.5");
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("local machine");
});

test("GET /sources/:id/key allows a loopback client", async () => {
  const res = await callKey("127.0.0.1");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { apiKey: string };
  expect(body.apiKey).toBe("test-key-1234567890");
});
