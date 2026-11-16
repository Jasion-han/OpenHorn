import { expect, test } from "bun:test";
import {
  fetchPublicPage,
  MAX_DIRECT_PAGE_BYTES,
  readDirectPageBody,
  requestPinnedPage,
  resolvePublicPageRoute,
} from "./public-page-fetch";

const signal = () => AbortSignal.timeout(2000);

test("fake-IP page hosts resolve independently and the checked public IP is pinned for the request", async () => {
  let calls = 0;
  const response = await fetchPublicPage("https://vendor.example/pricing", {
    signal: signal(),
    resolveHostname: async () => ["198.18.0.44"],
    resolvePublicHostname: async (host) => {
      expect(host).toBe("vendor.example");
      return ["93.184.216.34"];
    },
    pinnedRequest: async (url, address) => {
      calls++;
      expect(url.href).toBe("https://vendor.example/pricing");
      expect(address).toBe("93.184.216.34");
      return new Response("original source");
    },
  });
  expect(await response.text()).toBe("original source");
  expect(calls).toBe(1);
});

test("ordinary public DNS is pinned too and never invokes independent DNS unnecessarily", async () => {
  const route = await resolvePublicPageRoute("https://vendor.example/docs", {
    signal: signal(),
    resolveHostname: async () => ["93.184.216.34"],
    resolvePublicHostname: async () => {
      throw new Error("unexpected external DNS");
    },
  });
  expect(route.addresses).toEqual(["93.184.216.34"]);
  expect(route.officialDocsProxy).toBe(false);
});

test("private/mixed/local/literal targets and invalid public DNS never reach transport", async () => {
  let requests = 0;
  for (const [url, systemAnswers, publicAnswers] of [
    ["http://127.0.0.1/private", ["93.184.216.34"], ["93.184.216.34"]],
    ["https://vendor.example/docs", ["10.0.0.1"], ["93.184.216.34"]],
    ["https://vendor.example/docs", ["198.18.0.44", "10.0.0.1"], ["93.184.216.34"]],
    ["https://vendor.example/docs", ["198.18.0.44"], ["10.0.0.1"]],
    ["https://vendor.example/docs", ["198.18.0.44"], ["93.184.216.34", "169.254.169.254"]],
    ["https://vendor.example/docs", ["198.18.0.44"], ["198.18.0.55"]],
    ["https://vendor.example/docs", ["198.18.0.44"], []],
  ] as Array<[string, string[], string[]]>) {
    await expect(
      fetchPublicPage(url, {
        signal: signal(),
        resolveHostname: async () => systemAnswers,
        resolvePublicHostname: async () => publicAnswers,
        pinnedRequest: async () => {
          requests++;
          return new Response("should not happen");
        },
      }),
    ).rejects.toThrow();
  }
  expect(requests).toBe(0);
});

test("a cancelled or stalled resolution cannot start a page request later", async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchPublicPage("https://vendor.example/", {
      signal: controller.signal,
      resolveHostname: async () => ["93.184.216.34"],
      pinnedRequest: async () => {
        requests++;
        return new Response();
      },
    }),
  ).rejects.toThrow();
  await expect(
    resolvePublicPageRoute("https://vendor.example/", {
      signal: AbortSignal.timeout(15),
      resolveHostname: async () => new Promise(() => {}),
    }),
  ).rejects.toThrow();
  expect(requests).toBe(0);
});

test("pinned transport connects to its literal destination while preserving the original Host", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return Response.json({
        host: request.headers.get("host"),
        path: new URL(request.url).pathname,
      });
    },
  });
  try {
    const url = new URL(`http://pin-target.invalid:${server.port}/exact-path`);
    const response = await requestPinnedPage(url, "127.0.0.1", signal());
    expect(await response.json()).toEqual({
      host: `pin-target.invalid:${server.port}`,
      path: "/exact-path",
    });
  } finally {
    await server.stop(true);
  }
});

test("HTTPS pinned transport refuses a non-TLS peer instead of downgrading", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("not TLS"),
  });
  try {
    await expect(
      requestPinnedPage(
        new URL(`https://pin-target.invalid:${server.port}/`),
        "127.0.0.1",
        AbortSignal.timeout(500),
      ),
    ).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

test("direct-page bodies accept ordinary large HTML but bound declared and streamed payloads", async () => {
  const html = "x".repeat(1_400_000);
  expect((await readDirectPageBody(new Response(html), signal())).length).toBe(html.length);
  await expect(
    readDirectPageBody(
      new Response("x", { headers: { "content-length": String(MAX_DIRECT_PAGE_BYTES + 1) } }),
      signal(),
    ),
  ).rejects.toThrow("response_too_large");
  await expect(
    readDirectPageBody(new Response("x".repeat(MAX_DIRECT_PAGE_BYTES + 1)), signal()),
  ).rejects.toThrow("response_too_large");
});

test("cancelling a real pinned response closes the owned request instead of hanging", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pending"));
          },
        }),
      ),
  });
  const controller = new AbortController();
  try {
    const response = await requestPinnedPage(
      new URL(`http://pin-target.invalid:${server.port}/`),
      "127.0.0.1",
      controller.signal,
    );
    const reading = readDirectPageBody(response, controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow();
  } finally {
    controller.abort();
    await server.stop(true);
  }
});
