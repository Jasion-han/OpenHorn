import { expect, test } from "bun:test";
import { summarizeProviderError } from "./providerErrorSummary";

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
