import { expect, test } from "bun:test";

test("review workspace HTTP/service and backup boundaries hold in an isolated child", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./reviewWorkspaces.fixture.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: "file::memory:",
        OPENHORN_TEST_DATABASE_URL: "file::memory:",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  if (child.exitCode !== 0) console.error(child.stderr.toString(), child.stdout.toString());
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) as string);
  expect(result.checks >= 20).toBe(true);
});
