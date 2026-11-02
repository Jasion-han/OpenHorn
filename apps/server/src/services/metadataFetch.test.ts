import { expect, test } from "bun:test";
import {
  fetchModelMetadata,
  metadataProxyBypass,
  parseMacMetadataProxy,
  resetMetadataProxyCache,
  resolveMetadataProxy,
} from "./metadataFetch";

const systemText = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7897
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
    2 : <local>
    3 : 10/8
    4 : 172.16/12
    5 : 192.168/16
    6 : 169.254/16
  }
}`;

test("macOS proxy parsing uses enabled manual settings and treats PAC as unsupported data", () => {
  expect(parseMacMetadataProxy(systemText)).toEqual({
    http: "http://127.0.0.1:7897",
    https: "http://127.0.0.1:7897",
    exceptions: [
      "localhost",
      "*.local",
      "<local>",
      "10/8",
      "172.16/12",
      "192.168/16",
      "169.254/16",
    ],
    pac: false,
  });
  const disabled = parseMacMetadataProxy(systemText.replace("HTTPSEnable : 1", "HTTPSEnable : 0"));
  expect(disabled.https).toBe(undefined);
  expect(
    parseMacMetadataProxy(
      "ProxyAutoConfigEnable : 1\nHTTPProxy : bad@host\nHTTPPort : 99999\nHTTPEnable : 1",
    ),
  ).toEqual({ http: undefined, exceptions: [], pac: true });
  expect(parseMacMetadataProxy("HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 8080").http).toBe(
    "http://[::1]:8080",
  );
});

test("loopback always bypasses proxies; listed local/private CIDRs and wildcards are honored", () => {
  for (const host of [
    "localhost",
    "sub.localhost",
    "127.0.0.1",
    "127.200.1.1",
    "[::1]",
    "[::ffff:127.1.2.3]",
  ])
    expect(metadataProxyBypass(new URL(`https://${host}/models`), [])).toBe(true);
  const exceptions = parseMacMetadataProxy(systemText).exceptions;
  for (const host of [
    "printer",
    "service.local",
    "10.2.3.4",
    "172.20.1.2",
    "192.168.23.4",
    "169.254.100.2",
    "[::ffff:10.2.3.4]",
  ])
    expect(metadataProxyBypass(new URL(`https://${host}/models`), exceptions)).toBe(true);
  for (const host of [
    "openrouter.ai",
    "8.8.8.8",
    "192.169.1.1",
    "172.32.1.1",
    "service.local.evil",
  ])
    expect(metadataProxyBypass(new URL(`https://${host}/models`), exceptions)).toBe(false);
  expect(metadataProxyBypass(new URL("https://api.example.com"), ["example.com"])).toBe(false);
  expect(metadataProxyBypass(new URL("https://api.example.com"), ["*.example.com"])).toBe(true);
  expect(metadataProxyBypass(new URL("https://8.8.8.8"), ["10/33", "999/8"])).toBe(false);
});

test("explicit environment proxies win without a system read, while NO_PROXY domains, ports and IPv6 bypass", async () => {
  resetMetadataProxyCache();
  let reads = 0;
  const base = {
    platform: "darwin",
    readSystemProxy: async () => {
      reads++;
      return systemText;
    },
  };
  expect(
    await resolveMetadataProxy(new URL("https://openrouter.ai/models"), {
      ...base,
      env: { HTTPS_PROXY: "http://env-proxy:8080", ALL_PROXY: "http://other:9090" },
    }),
  ).toBe("http://env-proxy:8080");
  expect(
    await resolveMetadataProxy(new URL("http://example.com/models"), {
      ...base,
      env: { http_proxy: "http://lowercase:8080" },
    }),
  ).toBe("http://lowercase:8080");
  expect(
    await resolveMetadataProxy(new URL("https://example.com/models"), {
      ...base,
      env: { ALL_PROXY: "http://all-proxy:8080" },
    }),
  ).toBe("http://all-proxy:8080");
  expect(
    await resolveMetadataProxy(new URL("https://api.example.com/models"), {
      ...base,
      env: { HTTPS_PROXY: "http://env-proxy:8080", NO_PROXY: ".example.com:443" },
    }),
  ).toBe("");
  expect(
    await resolveMetadataProxy(new URL("https://api.example.com:444/models"), {
      ...base,
      env: { HTTPS_PROXY: "http://env-proxy:8080", NO_PROXY: ".example.com:443" },
    }),
  ).toBe("http://env-proxy:8080");
  expect(
    await resolveMetadataProxy(new URL("https://[fd00::1]/models"), {
      ...base,
      env: { ALL_PROXY: "http://all:8080", no_proxy: "[fd00::1]:443" },
    }),
  ).toBe("");
  expect(
    await resolveMetadataProxy(new URL("https://127.0.0.1/models"), {
      ...base,
      env: { ALL_PROXY: "http://all:8080" },
    }),
  ).toBe("");
  expect(
    await resolveMetadataProxy(new URL("https://example.com/models"), {
      ...base,
      env: { HTTP_PROXY: "http://runtime-http:8080" },
    }),
  ).toBe(undefined);
  expect(reads).toBe(0);
});

test("macOS system settings are cached for 30 seconds and simultaneous reads are single-flight", async () => {
  resetMetadataProxyCache();
  let now = 100,
    reads = 0;
  const dependencies = {
    platform: "darwin",
    env: {},
    now: () => now,
    readSystemProxy: async () => {
      reads++;
      return systemText;
    },
  };
  const values = await Promise.all(
    Array.from({ length: 10 }, () =>
      resolveMetadataProxy(new URL("https://openrouter.ai/models"), dependencies),
    ),
  );
  expect(values.every((value) => value === "http://127.0.0.1:7897")).toBe(true);
  expect(reads).toBe(1);
  now = 30_099;
  await resolveMetadataProxy(new URL("https://models.dev/models.json"), dependencies);
  expect(reads).toBe(1);
  now = 30_101;
  await resolveMetadataProxy(new URL("https://models.dev/models.json"), dependencies);
  expect(reads).toBe(2);
  expect(await resolveMetadataProxy(new URL("https://192.168.1.3/models"), dependencies)).toBe("");
  expect(await resolveMetadataProxy(new URL("https://api.local/models"), dependencies)).toBe("");
  resetMetadataProxyCache();
});

test("non-macOS, absent settings, failed reads and PAC-only settings fall back without changing routing", async () => {
  let reads = 0;
  const reader = async () => {
    reads++;
    return systemText;
  };
  resetMetadataProxyCache();
  expect(
    await resolveMetadataProxy(new URL("https://example.com/models"), {
      platform: "linux",
      env: {},
      readSystemProxy: reader,
    }),
  ).toBe(undefined);
  expect(reads).toBe(0);
  for (const result of [
    null,
    "<dictionary> {}",
    "ProxyAutoConfigEnable : 1",
    `${systemText}\nProxyAutoConfigEnable : 1`,
  ]) {
    resetMetadataProxyCache();
    expect(
      await resolveMetadataProxy(new URL("https://example.com/models"), {
        platform: "darwin",
        env: {},
        readSystemProxy: async () => result,
      }),
    ).toBe(undefined);
  }
  resetMetadataProxyCache();
  let failedReads = 0;
  const dependencies = {
    platform: "darwin",
    env: {},
    readSystemProxy: async () => {
      failedReads++;
      throw new Error("scutil unavailable");
    },
  };
  expect(await resolveMetadataProxy(new URL("https://example.com/models"), dependencies)).toBe(
    undefined,
  );
  expect(await resolveMetadataProxy(new URL("https://example.com/models"), dependencies)).toBe(
    undefined,
  );
  expect(failedReads).toBe(1);
  resetMetadataProxyCache();
});

test("metadata fetch keeps the injected fetch and request deadline, adds JSON headers and a scoped proxy", async () => {
  resetMetadataProxyCache();
  const priorFetch = globalThis.fetch;
  let seen: (RequestInit & { proxy?: string }) | undefined;
  const controller = new AbortController();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = init;
    return Response.json({ data: [] });
  }) as unknown as typeof fetch;
  try {
    const response = await fetchModelMetadata(
      "https://openrouter.ai/api/v1/models",
      { signal: controller.signal, redirect: "error", headers: { "X-Fixture": "keep" } },
      { platform: "darwin", env: {}, readSystemProxy: async () => systemText },
    );
    expect(response.ok).toBe(true);
    expect(seen?.proxy).toBe("http://127.0.0.1:7897");
    expect(seen?.signal).toBe(controller.signal);
    expect(seen?.redirect).toBe("error");
    const headers = new Headers(seen?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("OpenHorn/1.0 context-capabilities");
    expect(headers.get("x-fixture")).toBe("keep");
    expect(headers.has("authorization")).toBe(false);
  } finally {
    globalThis.fetch = priorFetch;
    resetMetadataProxyCache();
  }
});
