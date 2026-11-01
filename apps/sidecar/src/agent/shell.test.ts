import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runShellCommand } from "./shell";

// The actual descendant announces readiness, then waits until the test releases
// it. Elapsed wall time must never allow the marker to precede cancellation.
const gatedBackgroundCommand =
  "sh -c 'printf ready > child-ready; while [ ! -f release ]; do sleep 0.01; done; printf escaped > marker' & wait";

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function waitForDescendant(cwd: string) {
  const deadline = Date.now() + 2000;
  while (!(await exists(path.join(cwd, "child-ready")))) {
    if (Date.now() > deadline) throw new Error("background descendant never became ready");
    await Bun.sleep(5);
  }
}

test("shell Stop kills background descendants before they can write after cancellation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-shell-stop-"));
  const controller = new AbortController();
  const run = runShellCommand(gatedBackgroundCommand, cwd, {
    signal: controller.signal,
    timeoutMs: 3000,
    maxBuffer: 1024,
  });
  try {
    await waitForDescendant(cwd);
    controller.abort();
    await writeFile(path.join(cwd, "release"), "released after cancellation");
    // The descendant inherits output pipes. Even a root-only kill must wait
    // for that descendant to exit, making its post-release marker observable.
    expect(await run).toBe("Error: Command cancelled");
    expect(await exists(path.join(cwd, "marker"))).toBe(false);
  } finally {
    controller.abort();
    await writeFile(path.join(cwd, "release"), "cleanup release");
    await run;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("background descendant can write its marker when explicitly released without Stop", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-shell-release-"));
  const controller = new AbortController();
  const run = runShellCommand(gatedBackgroundCommand, cwd, {
    signal: controller.signal,
    timeoutMs: 3000,
    maxBuffer: 1024,
  });
  try {
    await waitForDescendant(cwd);
    expect(await exists(path.join(cwd, "marker"))).toBe(false);
    await writeFile(path.join(cwd, "release"), "normal release");
    expect(await run).toBe("(no output)");
    expect(await exists(path.join(cwd, "marker"))).toBe(true);
  } finally {
    controller.abort();
    await writeFile(path.join(cwd, "release"), "cleanup release");
    await run;
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
