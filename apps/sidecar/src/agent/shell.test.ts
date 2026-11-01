import { expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runShellCommand } from "./shell";

test("shell Stop kills background descendants before they can write after cancellation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-shell-stop-"));
  const controller = new AbortController();
  try {
    const run = runShellCommand(
      'printf ready > started; sh -c "sleep 0.25; printf escaped > marker" & wait',
      cwd,
      { signal: controller.signal, timeoutMs: 3000, maxBuffer: 1024 },
    );
    const deadline = Date.now() + 2000;
    while (
      !(await access(path.join(cwd, "started")).then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() > deadline) throw new Error("shell never started");
      await Bun.sleep(5);
    }
    controller.abort();
    expect(await run).toBe("Error: Command cancelled");
    await Bun.sleep(350);
    expect(
      await access(path.join(cwd, "marker")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    controller.abort();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shell preserves output, exit failures, timeout and buffer limits", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-shell-output-"));
  const options = { timeoutMs: 2000, maxBuffer: 1024 };
  try {
    expect(await runShellCommand("printf out; printf err >&2", cwd, options)).toBe("out\nerr");
    expect(await runShellCommand("exit 3", cwd, options)).toContain("Error:");
    expect(await runShellCommand("sleep 2", cwd, { ...options, timeoutMs: 20 })).toContain(
      "timed out",
    );
    const output = await runShellCommand("printf 123456789", cwd, { ...options, maxBuffer: 4 });
    expect(output).toBe("1234");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
