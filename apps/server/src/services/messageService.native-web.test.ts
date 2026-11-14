import { expect, test } from "bun:test";

test("native Chat end-to-end uses temporary SQLite and synthetic provider responses", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      new URL("./messageService.native-web.fixture.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, NODE_ENV: "test", ENCRYPTION_KEY: "{{SECRET_whywzkn7}}" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25000,
    },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  expect(JSON.parse(child.stdout.toString())).toMatchObject({
    prepare: true,
    replay: true,
    ownership: true,
    refusal: true,
    sse: true,
    retry: true,
    dataOnly: true,
    history: true,
  });
});
