import { execFile } from "node:child_process";
import { isIP } from "node:net";

const PROXY_CACHE_MS = 30_000;
export interface SystemMetadataProxy {
  http?: string;
  https?: string;
  exceptions: string[];
  /** PAC cannot be evaluated here; no PAC requests or credential prompts. */
  pac: boolean;
}

function proxyAddress(host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d+$/.test(port)) return undefined;
  const number = Number(port);
  if (number < 1 || number > 65535) return undefined;
  const plain = host.replace(/^\[|\]$/g, "");
  if (!isIP(plain) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(plain)) return undefined;
  return `http://${isIP(plain) === 6 ? `[${plain}]` : plain}:${number}`;
}

/** scutil is data, never a command, executable configuration or a PAC script. */
export function parseMacMetadataProxy(text: string): SystemMetadataProxy {
  const fields = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*ExceptionsList\s*:\s*<array>\s*\{/.test(line)) {
      inExceptions = true;
      continue;
    }
    if (inExceptions) {
      if (/^\s*\}/.test(line)) {
        inExceptions = false;
        continue;
      }
      const entry = /^\s*\d+\s*:\s*(.*?)\s*$/.exec(line);
      if (entry?.[1]) exceptions.push(entry[1]);
      continue;
    }
    const entry =
      /^\s*(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*(.*?)\s*$/.exec(
        line,
      );
    if (entry) fields.set(entry[1], entry[2]);
  }
  return {
    ...(fields.get("HTTPEnable") === "1"
      ? { http: proxyAddress(fields.get("HTTPProxy"), fields.get("HTTPPort")) }
      : {}),
    ...(fields.get("HTTPSEnable") === "1"
      ? { https: proxyAddress(fields.get("HTTPSProxy"), fields.get("HTTPSPort")) }
      : {}),
    exceptions,
    pac:
      fields.get("ProxyAutoConfigEnable") === "1" || fields.get("ProxyAutoDiscoveryEnable") === "1",
  };
}

function ipv4(host: string): number | null {
  if (isIP(host) !== 4) return null;
  return host.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}
function ipv4OrMapped(host: string): number | null {
  const direct = ipv4(host);
  if (direct !== null) return direct;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  return mapped
    ? (Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16)) >>> 0
    : null;
}
function cidrMatches(host: string, pattern: string): boolean {
  const matched = /^((?:\d{1,3}\.){0,3}\d{1,3})\/(\d{1,2})$/.exec(pattern);
  if (!matched) return false;
  const bits = Number(matched[2]);
  const parts = matched[1].split(".").map(Number);
  if (bits > 32 || parts.some((part) => part > 255)) return false;
  while (parts.length < 4) parts.push(0);
  const base = ipv4(parts.join("."));
  const address = ipv4OrMapped(host);
  if (base === null || address === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}
function hostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
function loopback(host: string): boolean {
  const address = ipv4OrMapped(host);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    (address !== null && address >>> 24 === 127)
  );
}

/** Match system exceptions literally/wildcard/CIDR; NO_PROXY also permits domain suffixes/ports. */
export function metadataProxyBypass(
  url: URL,
  exceptions: readonly string[],
  envStyle = false,
): boolean {
  const host = hostname(url);
  if (loopback(host)) return true;
  const targetPort = url.port || (url.protocol === "https:" ? "443" : "80");
  return exceptions.some((value) => {
    let pattern = value.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "<local>") return isIP(host) === 0 && !host.includes(".");
    if (pattern === "*") return true;
    if (pattern.includes("/")) return cidrMatches(host, pattern);
    if (envStyle) {
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(pattern);
      if (bracketed) {
        if (bracketed[2] && bracketed[2] !== targetPort) return false;
        pattern = bracketed[1];
      } else if (isIP(pattern) !== 6) {
        const port = /^(.*):(\d+)$/.exec(pattern);
        if (port) {
          if (port[2] !== targetPort) return false;
          pattern = port[1];
        }
      }
    }
    pattern = pattern.replace(/^\[|\]$/g, "");
    if (pattern.includes("*")) {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}$`, "i").test(host);
    }
    if (envStyle || pattern.startsWith(".")) {
      const domain = pattern.replace(/^\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    }
    return host === pattern;
  });
}

function readMacProxy(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/scutil",
      ["--proxy"],
      { encoding: "utf8", timeout: 500, maxBuffer: 32 * 1024 },
      (error, stdout) => {
        resolve(error ? null : stdout);
      },
    );
  });
}

let proxyCache: SystemMetadataProxy | null = null;
let proxyCacheUntil = 0;
let proxyInFlight: Promise<SystemMetadataProxy | null> | null = null;

interface MetadataProxyDependencies {
  platform?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  readSystemProxy?: () => Promise<string | null>;
}

async function systemProxy(
  dependencies: MetadataProxyDependencies,
): Promise<SystemMetadataProxy | null> {
  const now = dependencies.now ?? Date.now;
  if (proxyInFlight) return proxyInFlight;
  if (now() < proxyCacheUntil) return proxyCache;
  proxyInFlight = Promise.resolve().then(async () => {
    try {
      const text = await (dependencies.readSystemProxy ?? readMacProxy)();
      proxyCache = text ? parseMacMetadataProxy(text) : null;
    } catch {
      proxyCache = null;
    } finally {
      proxyCacheUntil = now() + PROXY_CACHE_MS;
      proxyInFlight = null;
    }
    return proxyCache;
  });
  return proxyInFlight;
}

/** Return an explicit empty proxy for bypass, undefined for the runtime's direct/default behavior. */
export async function resolveMetadataProxy(
  url: URL,
  dependencies: MetadataProxyDependencies = {},
): Promise<string | undefined> {
  const env = dependencies.env ?? process.env;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? "";
  if (metadataProxyBypass(url, noProxy.split(/[,\s]+/), true)) return "";
  // Existing explicit environment routing wins; do not read/rewrite the system
  // settings or silently replace an unsupported environment proxy with another.
  const schemeProxy =
    url.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy
      : env.HTTP_PROXY || env.http_proxy;
  const selected = schemeProxy || env.ALL_PROXY || env.all_proxy;
  if (selected) return selected;
  if (
    [
      env.HTTP_PROXY,
      env.http_proxy,
      env.HTTPS_PROXY,
      env.https_proxy,
      env.ALL_PROXY,
      env.all_proxy,
    ].some(Boolean)
  )
    return undefined;
  if ((dependencies.platform ?? process.platform) !== "darwin") return undefined;
  const system = await systemProxy(dependencies);
  if (system?.pac) return undefined;
  if (!system || metadataProxyBypass(url, system.exceptions)) return system ? "" : undefined;
  return url.protocol === "https:" ? system.https : system.http;
}

/** Scoped only to read-only model metadata. Global fetch stays injectable for deterministic tests. */
export async function fetchModelMetadata(
  input: string | URL | Request,
  init: RequestInit = {},
  dependencies: MetadataProxyDependencies = {},
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const proxy = await resolveMetadataProxy(url, dependencies);
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "OpenHorn/1.0 context-capabilities");
  return globalThis.fetch(input, { ...init, headers, ...(proxy !== undefined ? { proxy } : {}) });
}

export function resetMetadataProxyCache(): void {
  proxyCache = null;
  proxyCacheUntil = 0;
  proxyInFlight = null;
}
