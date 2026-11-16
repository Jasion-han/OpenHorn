import { expect, test } from "bun:test";
import { createServerApi } from "./serverApi";

test("native credentials use a dedicated two-segment route and cannot fall back to an older plaintext generic settings writer", async () => {
  const calls: string[] = [];
  let legacyWrites = 0;
  const api = createServerApi({
    baseUrl: "http://127.0.0.1:3002",
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method} ${url.pathname}`);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2 && parts[0] === "settings") {
        legacyWrites++;
        return Response.json({ success: true });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch,
  });
  let failed = false;
  try {
    await api.settings.setNativeSearchConnection(
      JSON.stringify({ source: "manual", apiKey: "synthetic-native-secret" }),
    );
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(legacyWrites).toBe(0);
  expect(calls).toEqual(["PUT /settings/search/native-connection"]);
});

test("OpenRouter search Key cannot reach an older generic settings plaintext writer", async () => {
  const calls: string[] = [];
  let legacyWrites = 0;
  const api = createServerApi({
    baseUrl: "http://127.0.0.1:3002",
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method} ${url.pathname}`);
      if (url.pathname.split("/").filter(Boolean).length === 2) {
        legacyWrites++;
        return Response.json({ success: true });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch,
  });
  let failed = false;
  try {
    await api.settings.setOpenRouterSearchConnection(
      JSON.stringify({ apiKey: "fixture-router-search" }),
    );
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(legacyWrites).toBe(0);
  expect(calls).toEqual(["PUT /settings/search/openrouter-connection"]);
});
