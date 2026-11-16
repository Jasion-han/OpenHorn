import { isIP } from "node:net";

/** Conservative public-address policy, also used on DNS answers before paid Fetch. */
export function isBlockedIpAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes("%")) return true;
  if (isIP(host) === 4) {
    const [a, b, c] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(host) !== 6) return false;
  // WHATWG canonicalization turns dotted IPv4-mapped tails into hex groups.
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  const mapped = canonical.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isBlockedIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // Restrict to global unicast; reject 6to4 and documentation/special ranges.
  const first = Number.parseInt(canonical.split(":")[0], 16);
  return (
    !(first >= 0x2000 && first <= 0x3fff) ||
    first === 0x2002 ||
    canonical.startsWith("2001:db8:") ||
    canonical.startsWith("2001:0:")
  );
}

/** Syntax/literal checks only. Does not perform DNS or fetch a citation target. */
export function parsePublicWebUrl(raw: string): URL {
  if (
    !raw ||
    raw.length > 8192 ||
    Array.from(raw).some((c) => {
      const code = c.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error("unsafe_url");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("unsafe_url");
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/?#]*@/i.test(raw) ||
    !host ||
    host === "localhost" ||
    /\.(localhost|local|localdomain|internal|lan|home)$/.test(host) ||
    (!host.includes(".") && !host.includes(":")) ||
    isBlockedIpAddress(host)
  ) {
    throw new Error("unsafe_url");
  }
  return url;
}

export type ResolveWebHostname = (hostname: string) => Promise<string[]>;
const defaultResolve: ResolveWebHostname = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(hostname, { all: true })).map(({ address }) => address);
};

const TRUSTED_DOCUMENTATION_ORIGIN = "https://api-docs.deepseek.com";
const isProxyFakeIp = (address: string) => {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
};

async function assertWebUrl(
  raw: string,
  resolveHostname: ResolveWebHostname = defaultResolve,
  allowOfficialDocumentationProxy = false,
): Promise<void> {
  const url = parsePublicWebUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const { networkInterfaces } = await import("node:os");
  const canonicalIp = (address: string) =>
    isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
  const localAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map(({ address }) => canonicalIp(address.split("%")[0])),
    ),
  );
  if (isIP(hostname)) {
    if (localAddresses.has(canonicalIp(hostname))) throw new Error("unsafe_url");
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new Error("unsafe_url");
  }
  // This static vendor documentation origin is authenticated by HTTPS/TLS, like
  // our fixed official API endpoints. Never apply its proxy exception to an
  // arbitrary host, HTTP URL, mixed DNS answers, literal IP, or local interface.
  const officialDocumentationProxy =
    allowOfficialDocumentationProxy &&
    url.origin === TRUSTED_DOCUMENTATION_ORIGIN &&
    addresses.length > 0 &&
    addresses.every(isProxyFakeIp);
  if (
    !addresses.length ||
    addresses.some((a) => !isIP(a) || localAddresses.has(canonicalIp(a))) ||
    (!officialDocumentationProxy && addresses.some(isBlockedIpAddress))
  ) {
    throw new Error("unsafe_url");
  }
}

/** All DNS answers must be public; paid tools and arbitrary targets fail closed. */
export const assertPublicWebUrl = (raw: string, resolveHostname?: ResolveWebHostname) =>
  assertWebUrl(raw, resolveHostname);

/** Page reads may use a fake-IP proxy only for the fixed official HTTPS docs origin. */
export const assertPublicPageUrl = (raw: string, resolveHostname?: ResolveWebHostname) =>
  assertWebUrl(raw, resolveHostname, true);
