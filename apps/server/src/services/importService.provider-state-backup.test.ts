import { expect, test } from "bun:test";

test("OpenHorn export/delete/import preserves valid Chat signatures and omits invalid or Agent continuation state", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      new URL("./importService.provider-state-backup.fixture.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "null")).toEqual({
    messages: 12,
    retained: 2,
    clearedWithWarnings: 9,
    boundaryBytes: 256 * 1024,
    signatureExact: true,
    deletedBeforeImport: true,
    agentStateCleared: true,
    warningsPersisted: true,
    networkAttempts: 0,
  });
});
