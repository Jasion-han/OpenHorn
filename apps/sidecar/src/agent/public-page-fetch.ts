import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import {
  assertPublicPageUrl,
  assertPublicWebUrl,
  parsePublicWebUrl,
  type ResolveWebHostname,
  readBoundedWebResponse,
} from "shared/search";
import { sanitizeChildEnv } from "./childEnv";

const systemResolve: ResolveWebHostname = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/** Direct HTML pages may include large scripts; paid JSON tools retain their 1 MiB cap. */
export const MAX_DIRECT_PAGE_BYTES = 2 * 1024 * 1024;

export async function readDirectPageBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_DIRECT_PAGE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await abortablePageWork(reader.read(), signal);
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_DIRECT_PAGE_BYTES) throw new Error("response_too_large");
      chunks.push(part.value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(buffer);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

const isFakeIp = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return isIP(ip) === 4 && a === 198 && (b === 18 || b === 19);
};

export async function abortablePageWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Only pure fake-IP proxy answers trigger independent public DNS resolution. */
export async function resolvePublicPageRoute(
  raw: string,
  options: {
    signal: AbortSignal;
    resolveHostname?: ResolveWebHostname;
    resolvePublicHostname?: ResolveWebHostname;
  },
): Promise<{ url: URL; addresses: string[]; officialDocsProxy: boolean }> {
  options.signal.throwIfAborted();
  const url = parsePublicWebUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses = isIP(hostname)
    ? [hostname]
    : await abortablePageWork((options.resolveHostname ?? systemResolve)(hostname), options.signal);
  const fake = addresses.length > 0 && addresses.every(isFakeIp);
  if (url.origin === "https://api-docs.deepseek.com") {
    await assertPublicPageUrl(raw, async () => addresses);
    return { url, addresses, officialDocsProxy: true };
  }
  if (fake) {
    const local = new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? []).map((entry) => entry.address),
      ),
    );
    if (addresses.some((ip) => local.has(ip))) throw new Error("unsafe_url");
    addresses = await abortablePageWork(
      options.resolvePublicHostname
        ? options.resolvePublicHostname(hostname)
        : resolvePublicDns(hostname, options.signal),
      options.signal,
    );
  }
  await assertPublicWebUrl(raw, async () => addresses);
  options.signal.throwIfAborted();
  return { url, addresses, officialDocsProxy: false };
}

async function resolvePublicDns(hostname: string, signal: AbortSignal): Promise<string[]> {
  const answers = await Promise.all(
    [1, 28].map(async (type) => {
      const endpoint = new URL("https://dns.google/resolve");
      endpoint.searchParams.set("name", hostname);
      endpoint.searchParams.set("type", String(type));
      const response = await fetch(endpoint, {
        signal,
        redirect: "error",
        headers: { Accept: "application/dns-json" },
        tls: { rejectUnauthorized: true },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("public_dns_failed");
      }
      const value = JSON.parse(await readBoundedWebResponse(response, 64 * 1024, signal));
      if (value?.Status !== 0 || (value.Answer !== undefined && !Array.isArray(value.Answer)))
        throw new Error("public_dns_failed");
      return (value.Answer ?? []).flatMap((entry: { type?: unknown; data?: unknown }) => {
        if (entry.type !== type) return [];
        if (typeof entry.data !== "string" || isIP(entry.data) !== (type === 1 ? 4 : 6))
          throw new Error("public_dns_failed");
        return [entry.data];
      });
    }),
  );
  return [...new Set(answers.flat())];
}

export type PinnedPageRequest = (
  url: URL,
  address: string,
  signal: AbortSignal,
) => Promise<Response>;

/** curl --resolve pins TCP without changing the URL's Host/SNI/certificate identity. */
export const requestPinnedPage: PinnedPageRequest = async (url, address, signal) => {
  signal.throwIfAborted();
  const executable = Bun.which("curl");
  if (!executable)
    throw new Error("page_transport_unavailable: curl is required for safe page reads");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const pinnedAddress = isIP(address) === 6 ? `[${address}]` : address;
  const child = Bun.spawn({
    cmd: [
      executable,
      "--disable",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--proto",
      "=http,https",
      "--max-time",
      "30",
      "--max-filesize",
      String(MAX_DIRECT_PAGE_BYTES),
      ...(isIP(hostname) ? [] : ["--resolve", `${hostname}:${port}:${pinnedAddress}`]),
      "--user-agent",
      "OpenHorn/1.0 (compatible; bot)",
      "--compressed",
      "--dump-header",
      "-",
      "--output",
      "-",
      "--url",
      url.href,
    ],
    env: sanitizeChildEnv({ ...process.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const abort = () => {
    child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const close = async () => {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    void reader.cancel().catch(() => {});
    await child.exited;
  };
  const checkExit = async () => {
    const code = await child.exited;
    signal.throwIfAborted();
    if (code !== 0)
      throw new Error(
        code === 60 || code === 51 || code === 35
          ? "page_tls_failed"
          : code === 28
            ? "timeout"
            : "page_request_failed",
      );
  };
  let pending = new Uint8Array(0);
  let headerBytes = 0;
  try {
    let status = 0;
    let headers = new Headers();
    while (true) {
      let boundary = -1;
      for (let i = 0; i + 3 < pending.length; i++) {
        if (
          pending[i] === 13 &&
          pending[i + 1] === 10 &&
          pending[i + 2] === 13 &&
          pending[i + 3] === 10
        ) {
          boundary = i;
          break;
        }
      }
      if (boundary < 0) {
        const part = await abortablePageWork(reader.read(), signal);
        if (part.done) {
          await checkExit();
          throw new Error("invalid_page_response");
        }
        const combined = new Uint8Array(pending.length + part.value.length);
        combined.set(pending);
        combined.set(part.value, pending.length);
        pending = combined;
        if (
          pending.length > 64 * 1024 &&
          !new TextDecoder().decode(pending.subarray(0, 64 * 1024)).includes("\r\n\r\n")
        )
          throw new Error("page_headers_too_large");
        continue;
      }
      headerBytes += boundary + 4;
      if (headerBytes > 64 * 1024) throw new Error("page_headers_too_large");
      const lines = new TextDecoder().decode(pending.subarray(0, boundary)).split("\r\n");
      pending = pending.slice(boundary + 4);
      const match = lines.shift()?.match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/);
      if (!match) throw new Error("invalid_page_response");
      status = Number(match[1]);
      headers = new Headers();
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error("invalid_page_response");
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      if (status >= 100 && status < 200 && status !== 101) continue;
      if (status < 200 || status > 599) throw new Error("invalid_page_response");
      break;
    }
    if ([204, 205, 304].includes(status)) {
      await close();
      return new Response(null, { status, headers });
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (pending.length) {
            const chunk = pending;
            pending = new Uint8Array(0);
            controller.enqueue(chunk);
            return;
          }
          const part = await abortablePageWork(reader.read(), signal);
          if (part.done) {
            await checkExit();
            controller.close();
            await close();
          } else controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
          await close();
        }
      },
      async cancel() {
        await close();
      },
    });
    return new Response(body, { status, headers });
  } catch (error) {
    await close();
    throw error;
  }
};

export async function fetchPublicPage(
  raw: string,
  options: {
    signal: AbortSignal;
    resolveHostname?: ResolveWebHostname;
    resolvePublicHostname?: ResolveWebHostname;
    pinnedRequest?: PinnedPageRequest;
    fetchImpl?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;
  },
): Promise<Response> {
  const route = await resolvePublicPageRoute(raw, options);
  options.signal.throwIfAborted();
  if (route.officialDocsProxy || options.fetchImpl) {
    const init = {
      signal: options.signal,
      redirect: "manual" as const,
      tls: { rejectUnauthorized: true },
      headers: { "User-Agent": "OpenHorn/1.0 (compatible; bot)" },
    };
    return (options.fetchImpl ?? fetch)(route.url, init);
  }
  const address = route.addresses.find((ip) => isIP(ip) === 4) ?? route.addresses[0];
  return (options.pinnedRequest ?? requestPinnedPage)(route.url, address, options.signal);
}
