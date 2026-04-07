import { expect, test } from "bun:test";
import { classifyProviderError, summarizeProviderError } from "./providerErrorSummary";

test("summarizeProviderError extracts cloudflare 525 title", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>204152.xyz | 525: SSL handshake failed</title></head>
      <body>huge cloudflare page</body>
    </html>
  `;

  expect(summarizeProviderError(html, { status: 525 })).toBe("525: SSL handshake failed");
});

test("summarizeProviderError trims long plain text", () => {
  const text =
    "This is a very long upstream error message that should be compressed before it reaches the UI because raw provider payloads are noisy and hard to read.";

  expect(summarizeProviderError(text).length).toBeLessThanOrEqual(120);
  expect(summarizeProviderError(text)).toStartWith("This is a very long upstream error message");
});

test("summarizeProviderError falls back to status message when text is empty", () => {
  expect(summarizeProviderError("", { status: 502 })).toBe("Request failed (502)");
});

test("classifyProviderError normalizes quota errors for agent usage", () => {
  expect(classifyProviderError("Provider API error (429): hour allocated quota exceeded.")).toEqual({
    kind: "quota_exhausted",
    raw: "Provider API error (429): hour allocated quota exceeded.",
    summary: "Provider API error (429): hour allocated quota exceeded.",
    userMessage: "配额不足或触发限流：小时配额已耗尽。",
    status: 429,
    retryable: true,
  });
});

test("classifyProviderError normalizes ssl handshake failures", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>204152.xyz | 525: SSL handshake failed</title></head>
      <body>huge cloudflare page</body>
    </html>
  `;

  expect(classifyProviderError(html, { status: 525 })).toEqual({
    kind: "ssl_handshake_failed",
    raw: html.trim(),
    summary: "525: SSL handshake failed",
    userMessage: "TLS/SSL 握手失败：204152.xyz | 525: SSL 握手失败。请检查 Base URL、证书链或中转服务。",
    status: 525,
    retryable: false,
  });
});

test("classifyProviderError normalizes auth failures", () => {
  expect(classifyProviderError("Provider API error (500): No cookie available")).toEqual({
    kind: "auth_failed",
    raw: "Provider API error (500): No cookie available",
    summary: "Provider API error (500): No cookie available",
    userMessage: "鉴权失败：缺少 Cookie。",
    status: 500,
    retryable: false,
  });
});
