import { expect, test } from "bun:test";

test("real upload route preserves every PDF/page field and rejects ambiguous scope", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      new URL("./attachmentDocument.fixture.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, NODE_ENV: "test", ENCRYPTION_KEY: "synthetic-document-upload-key" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(JSON.parse(child.stdout.toString())).toEqual({
    multipartFiles: 4,
    exactFileBytesAndIdentity: true,
    ambiguousScopeRejected: true,
  });
});
