import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertIsolatedTestDatabase, UnsafeTestDatabaseError } from "./testDatabaseGuard";

const ownedDirectories: string[] = [];
afterEach(async () => {
  for (const dir of ownedDirectories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), "openhorn-db-guard-")));
  ownedDirectories.push(owned);
  const project = path.join(owned, "workspace with spaces");
  const dbDir = path.join(project, "apps/server/src/db");
  const data = path.join(project, "data");
  await mkdir(dbDir, { recursive: true });
  await mkdir(data);
  // Exercise the real entry module in an owned workspace: even a regressed
  // guard can only create/open this synthetic default, never the normal DB.
  await Promise.all([
    copyFile(fileURLToPath(new URL("./index.ts", import.meta.url)), path.join(dbDir, "index.ts")),
    copyFile(
      fileURLToPath(new URL("./testDatabaseGuard.ts", import.meta.url)),
      path.join(dbDir, "testDatabaseGuard.ts"),
    ),
    symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      path.join(project, "apps/server/node_modules"),
      "dir",
    ),
  ]);
  const entry = path.join(dbDir, "index.ts");
  const defaultFile = path.join(data, "openhorn.db");
  const run = async (databaseUrl?: string, nodeEnv = "test", cwd = project) => {
    const script = `
      try {
        const { client } = await import(${JSON.stringify(pathToFileURL(entry).href)});
        await client.execute("SELECT 1");
        client.close();
        console.log(JSON.stringify({ imported: true }));
      } catch (error) {
        console.log(JSON.stringify({ imported: false, code: error.code, message: error.message }));
      }
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      cwd,
      // Intentionally no test preload or OPENHORN_TEST_DATABASE_URL. Empty
      // DATABASE_URL exercises the fallback without inheriting an ambient .env.
      env: { PATH: process.env.PATH ?? "", NODE_ENV: nodeEnv, DATABASE_URL: databaseUrl ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0 || stderr) throw new Error(`Guard child failed: ${stderr}`);
    return JSON.parse(stdout.trim()) as { imported: boolean; code?: string; message?: string };
  };
  return { project, data, defaultFile, run };
}

test("missing preload/default DB import fails before creating or opening any SQLite file", async () => {
  const f = await fixture();
  expect(existsSync(f.defaultFile)).toBe(false);
  const result = await f.run();
  expect(result.imported).toBe(false);
  expect(result.code).toBe("unsafe_test_database");
  expect(result.message).toContain("preload");
  expect(result.message).toContain("isolated temporary test database");
  expect(existsSync(f.defaultFile)).toBe(false);
  expect(existsSync(`${f.defaultFile}-wal`)).toBe(false);
  expect(existsSync(`${f.defaultFile}-shm`)).toBe(false);
});

test("relative, normalized, query and percent-encoded file aliases cannot bypass the import guard", async () => {
  const f = await fixture();
  const urls = [
    "file:./data/openhorn.db",
    "file:./data/../data/openhorn.db?tls=0",
    "file:./data/%6fpenhorn.db#ignored-fragment",
    `${pathToFileURL(f.defaultFile).href}?tls=0`,
    pathToFileURL(f.defaultFile).href.replace("file:///", "file://localhost/"),
    `file:${f.defaultFile}`,
  ];
  for (const url of urls) {
    expect((await f.run(url)).code).toBe("unsafe_test_database");
    expect(existsSync(f.defaultFile)).toBe(false);
  }
});

test("symlinked existing files, hard links, and a missing file under a symlinked directory are rejected", async () => {
  const f = await fixture();
  const dirAlias = path.join(f.project, "data-alias");
  await symlink(f.data, dirAlias, "dir");
  expect((await f.run("file:./data-alias/openhorn.db")).code).toBe("unsafe_test_database");
  expect(existsSync(f.defaultFile)).toBe(false);
  const fileAlias = path.join(f.project, "file-alias.db");
  await symlink(f.defaultFile, fileAlias);
  expect((await f.run(pathToFileURL(fileAlias).href)).code).toBe("unsafe_test_database");
  expect(existsSync(f.defaultFile)).toBe(false);
  // A deliberately non-SQLite sentinel proves aliases are rejected before the
  // client can interpret/open them, not because SQLite later rejects contents.
  await writeFile(f.defaultFile, "Owned sentinel, not a SQLite database");
  const hardAlias = path.join(f.project, "hard-alias.db");
  await link(f.defaultFile, hardAlias);
  for (const file of [fileAlias, hardAlias]) {
    expect((await f.run(pathToFileURL(file).href)).code).toBe("unsafe_test_database");
  }
});

test("an explicit isolated temp DB works without preload or OPENHORN_TEST_DATABASE_URL", async () => {
  const f = await fixture();
  const isolated = path.join(f.project, "isolated-test.db");
  expect((await f.run(pathToFileURL(isolated).href)).imported).toBe(true);
  expect(existsSync(isolated)).toBe(true);
  expect(existsSync(f.defaultFile)).toBe(false);
});

test("production imports keep the existing default DB behavior", async () => {
  const f = await fixture();
  expect((await f.run(undefined, "production")).imported).toBe(true);
  expect(existsSync(f.defaultFile)).toBe(true);
});

test("the pure guard keeps memory/remote URLs and non-test runtime behavior unchanged", async () => {
  const f = await fixture();
  for (const url of [
    ":memory:",
    "file::memory:",
    "file::memory:?cache=shared",
    "libsql://fixture.invalid",
  ]) {
    expect(() =>
      assertIsolatedTestDatabase(url, f.defaultFile, { nodeEnv: "test", cwd: f.project }),
    ).not.toThrow();
  }
  expect(() =>
    assertIsolatedTestDatabase(`file:${f.defaultFile}`, f.defaultFile, { nodeEnv: "production" }),
  ).not.toThrow();
  expect(() =>
    assertIsolatedTestDatabase("file:./data/openhorn.db", f.defaultFile, {
      nodeEnv: "test",
      cwd: f.project,
    }),
  ).toThrow(UnsafeTestDatabaseError);
});
