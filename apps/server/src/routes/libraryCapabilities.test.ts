import { expect, test } from "bun:test";

for (const scenario of ["cloud-only", "local", "leases"]) {
  test(`library HTTP capabilities match parser support: ${scenario}`, () => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        new URL("./libraryCapabilities.fixture.ts", import.meta.url).pathname,
        scenario,
      ],
      {
        env: { ...process.env, NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
      },
    );
    if (child.exitCode !== 0) console.error(child.stdout.toString(), child.stderr.toString());
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) as string);
    expect(result.checks > 10).toBe(true);
    expect(result.cloudRequests).toBe(0);
    console.log(JSON.stringify(result));
  });
}
