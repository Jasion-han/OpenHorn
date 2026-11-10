import { expect, test } from "bun:test";

test("library HTTP, indexing leases, question snapshots and backup isolate users/projects", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./library.fixture.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: "file::memory:",
        OPENHORN_TEST_DATABASE_URL: "file::memory:",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
    },
  );
  if (child.exitCode !== 0) console.error(child.stderr.toString(), child.stdout.toString());
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1) as string).checks >= 45).toBe(
    true,
  );
});
