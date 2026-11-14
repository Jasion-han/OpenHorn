import { expect, test } from "bun:test";
import { isSafeBackupSetting, sanitizeBackupEndpoint, sanitizeBackupMcp } from "./backupSanitizer";

test("safe backup endpoint keeps common API paths and strips every credential-bearing URL component", () => {
  expect(sanitizeBackupEndpoint("https://name:password@api.example/v1?key=secret#secret")).toBe(
    "https://api.example/v1",
  );
  expect(sanitizeBackupEndpoint("https://api.example/private-token-path")).toBe(
    "https://api.example/",
  );
  expect(sanitizeBackupEndpoint("https://api.example/api/v1")).toBe("https://api.example/api/v1");
  expect(sanitizeBackupEndpoint("file:///private/key")).toBe(null);
  expect(sanitizeBackupEndpoint("invalid secret")).toBe(null);
  expect(sanitizeBackupEndpoint(null)).toBe(null);
});

test("safe MCP descriptions never copy arbitrary fields or malformed raw configuration", () => {
  for (const config of [
    '{"command":"sh -c secret","args":["secret"],"nested":{"anonymous":"secret"}}',
    "not-json-secret",
    '["secret"]',
  ]) {
    expect(sanitizeBackupMcp({ type: "stdio", config, isEnabled: true })).toEqual({
      type: "stdio",
      config: '{"type":"stdio"}',
      isEnabled: false,
    });
  }
  expect(
    sanitizeBackupMcp({
      type: "http",
      config: '{"url":"https://private.example/key","headers":{"custom":"secret"}}',
      isEnabled: true,
    }),
  ).toEqual({ type: "http", config: '{"type":"http"}', isEnabled: false });
});

test("safe settings validate both the known key and the bounded value", () => {
  expect(isSafeBackupSetting({ key: "deepseek.toolsApiKey", value: "synthetic-tools-key" })).toBe(
    false,
  );
  expect(isSafeBackupSetting({ key: "deepseek.nativeWebEnabled", value: "true" })).toBe(true);
  expect(isSafeBackupSetting({ key: "liveSearch.provider", value: "deepseek" })).toBe(true);
  expect(isSafeBackupSetting({ key: "liveSearch.provider", value: "synthetic-secret" })).toBe(
    false,
  );
  expect(isSafeBackupSetting({ key: "liveSearch.tavilyEnabled", value: "true" })).toBe(true);
  expect(isSafeBackupSetting({ key: "liveSearch.tavilyEnabled", value: "false" })).toBe(true);
  expect(isSafeBackupSetting({ key: "liveSearch.tavilyEnabled", value: "secret" })).toBe(false);
  expect(isSafeBackupSetting({ key: "unrecognizedHarmlessName", value: "secret" })).toBe(false);
  expect(isSafeBackupSetting({ key: "chat.systemPrompt", value: "secret" })).toBe(false);
});
