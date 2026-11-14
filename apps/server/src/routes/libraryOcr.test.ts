import { expect, test } from "bun:test";

test("explicit OCR uses synthetic HTTP and isolated SQLite with ownership, quotas and leases", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./libraryOcr.fixture.ts", import.meta.url).pathname],
    {
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
    },
  );
  if (child.exitCode !== 0) console.error(child.stderr.toString(), child.stdout.toString());
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString().trim().split("\n").at(-1) as string).checks > 60).toBe(
    true,
  );
});
