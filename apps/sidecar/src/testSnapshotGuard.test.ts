import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertIsolatedTestSnapshotHome } from "./testSnapshotGuard";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "openhorn-snapshot-guard-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function refused(configuredHome: string | undefined, defaultHome: string, cwd?: string) {
  try {
    assertIsolatedTestSnapshotHome({ nodeEnv: "test", configuredHome, defaultHome, cwd });
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "unsafe_test_snapshot_home";
  }
}

test("test snapshot guard rejects absent/default/relative/ancestor/subtree aliases without IO", async () => {
  await fixture(async (root) => {
    const protectedHome = path.join(root, "fake-user", ".openhorn");
    await mkdir(protectedHome, { recursive: true });
    for (const selected of [
      undefined,
      "",
      "  ",
      protectedHome,
      path.join(root, "fake-user"),
      path.join(protectedHome, "child"),
      "./fake-user/.openhorn",
      `${protectedHome}/../.openhorn`,
    ]) {
      expect(refused(selected, protectedHome, root)).toBe(true);
    }
    expect(refused(path.join(root, "isolated"), protectedHome)).toBe(false);
  });
});

test("test snapshot guard resolves existing and dangling symlink aliases", async () => {
  await fixture(async (root) => {
    const protectedHome = path.join(root, "fake-user", ".openhorn");
    await mkdir(protectedHome, { recursive: true });
    const alias = path.join(root, "state-alias");
    await symlink(protectedHome, alias);
    expect(refused(alias, protectedHome)).toBe(true);
    expect(refused(path.join(alias, "new-state"), protectedHome)).toBe(true);
    const missingDefault = path.join(root, "missing-user", ".openhorn");
    const dangling = path.join(root, "dangling-state");
    await symlink(missingDefault, dangling);
    expect(refused(dangling, missingDefault)).toBe(true);
    expect(refused(path.join(dangling, "child"), missingDefault)).toBe(true);
  });
});

test("normal development and production snapshot behavior is unchanged", () => {
  for (const nodeEnv of ["development", "production"]) {
    let passed = true;
    try {
      assertIsolatedTestSnapshotHome({
        nodeEnv,
        configuredHome: undefined,
        defaultHome: "/unused",
      });
    } catch {
      passed = false;
    }
    expect(passed).toBe(true);
  }
});

test("checkpoint IO guards before any normal-default access even without package preload", async () => {
  await fixture(async (root) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./checkpoints.test-guard.fixture.ts", import.meta.url).pathname,
        root,
      ],
      { cwd: root, env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe" },
    );
    const out = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    try {
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
      expect(JSON.parse(await out)).toEqual({
        rejected: 18,
        sentinel: "preserved",
        protectedEntries: ["sentinel", "snapshots"],
        protectedSnapshotEntries: [],
        pureDefaultPath: true,
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await Promise.all([out, errors]);
    }
  });
});

test("test snapshot guard rejects actual derived-root aliases including dangling links", async () => {
  await fixture(async (root) => {
    const protectedHome = path.join(root, "normal-state");
    const selected = path.join(root, "selected-state");
    await mkdir(path.join(protectedHome, "snapshots"), { recursive: true });
    await mkdir(selected);
    await symlink(path.join(protectedHome, "snapshots"), path.join(selected, "snapshots"));
    expect(refused(selected, protectedHome)).toBe(true);
    const dangling = path.join(root, "selected-dangling");
    await mkdir(dangling);
    await symlink(path.join(root, "missing-normal", "snapshots"), path.join(dangling, "snapshots"));
    expect(refused(dangling, path.join(root, "missing-normal"))).toBe(true);
  });
});

test("test snapshot guard protects the normal snapshot root when it redirects outside the default home", async () => {
  await fixture(async (root) => {
    const protectedHome = path.join(root, "normal-state");
    const physical = path.join(root, "normal-physical-snapshots");
    const selected = path.join(root, "selected-state");
    await Promise.all([mkdir(protectedHome), mkdir(physical), mkdir(selected)]);
    await symlink(physical, path.join(protectedHome, "snapshots"));
    await symlink(physical, path.join(selected, "snapshots"));
    expect(refused(selected, protectedHome)).toBe(true);
    expect(refused(physical, protectedHome)).toBe(true);
  });
});
