import { expect, test } from "bun:test";
import { assertPublicPageUrl, assertPublicWebUrl } from "./webSafety";

const docs = "https://api-docs.deepseek.com/guides/responses_api.md";
const proxyDns = async () => ["198.18.0.25"];

test("only page reads of the fixed official HTTPS documentation origin accept proxy fake IPs", async () => {
  await assertPublicPageUrl(docs, proxyDns);
  await assertPublicPageUrl("https://api-docs.deepseek.com/quick_start/pricing.md", proxyDns);
  await expect(assertPublicWebUrl(docs, proxyDns)).rejects.toThrow("unsafe_url");
  await assertPublicPageUrl("https://example.com/docs", async () => ["93.184.216.34"]);
});

test("the documentation exception cannot be borrowed by HTTP, ports, credentials, suffixes or IP literals", async () => {
  for (const url of [
    "http://api-docs.deepseek.com/guides/responses_api.md",
    "https://api-docs.deepseek.com:444/guides/responses_api.md",
    "https://api-docs.deepseek.com.attacker.example/docs",
    "https://user@api-docs.deepseek.com/docs",
    "https://example.com/docs",
    "https://198.18.0.25/docs",
    "https://[::ffff:198.18.0.25]/docs",
  ]) {
    await expect(assertPublicPageUrl(url, proxyDns)).rejects.toThrow("unsafe_url");
  }
});

test("official documentation still rejects private, mixed, invalid, missing or failed DNS", async () => {
  for (const addresses of [
    ["127.0.0.1"],
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["::1"],
    ["198.18.0.25", "10.0.0.1"],
    ["198.18.0.25", "93.184.216.34"],
    ["not-an-address"],
    [],
  ]) {
    await expect(assertPublicPageUrl(docs, async () => addresses)).rejects.toThrow("unsafe_url");
  }
  await expect(
    assertPublicPageUrl(docs, async () => {
      throw new Error("dns_failed");
    }),
  ).rejects.toThrow("unsafe_url");
});
