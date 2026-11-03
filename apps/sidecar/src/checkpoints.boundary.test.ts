import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCheckpointSession,
  ensureCheckpointBackup,
  finalizeCheckpoint,
  pruneSnapshots,
  rollbackCheckpoint,
  workspaceSlug,
} from "./checkpoints";

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const owned = await realpath(await mkdtemp(path.join(tmpdir(), "openhorn-checkpoint-boundary-")));
  const previous = process.env.OPENHORN_HOME;
  process.env.OPENHORN_HOME = path.join(owned, "state");
  const root = path.join(owned, "workspace");
  const outside = path.join(owned, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  try {
    await run(root, outside);
  } finally {
    if (previous === undefined) delete process.env.OPENHORN_HOME;
    else process.env.OPENHORN_HOME = previous;
    await rm(owned, { recursive: true, force: true });
  }
}

async function rejected(run: () => Promise<unknown>) {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

for (const kind of ["file", "parent", "new-parent"] as const) {
  test(`rollback rejects ${kind} symlink escape without changing outside content`, async () => {
    await fixture(async (root, outside) => {
      const relative = kind === "file" ? "a.txt" : "dir/a.txt";
      await mkdir(path.join(root, "dir"));
      if (kind !== "new-parent") await writeFile(path.join(root, relative), "original");
      await writeFile(path.join(outside, "a.txt"), "OUTSIDE");
      const session = await createCheckpointSession(root);
      await ensureCheckpointBackup(session, relative);
      await finalizeCheckpoint(session);
      if (kind === "file") {
        await rm(path.join(root, relative));
        await symlink(path.join(outside, "a.txt"), path.join(root, relative));
      } else {
        await rm(path.join(root, "dir"), { recursive: true });
        await symlink(outside, path.join(root, "dir"));
      }
      expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
      expect(await readFile(path.join(outside, "a.txt"), "utf8")).toBe("OUTSIDE");
    });
  });
}

test("backup refuses a source symlink outside the workspace", async () => {
  await fixture(async (root, outside) => {
    await writeFile(path.join(outside, "secret.txt"), "outside-only");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "source.txt"));
    const session = await createCheckpointSession(root);
    expect(await rejected(() => ensureCheckpointBackup(session, "source.txt"))).toBe(true);
    expect(session.files.size).toBe(0);
  });
});

test("rollback refuses a planted snapshot symlink before writing the workspace", async () => {
  await fixture(async (root, outside) => {
    await writeFile(path.join(root, "a.txt"), "original");
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    await finalizeCheckpoint(session);
    await writeFile(path.join(root, "a.txt"), "current");
    await writeFile(path.join(outside, "secret.txt"), "outside-only");
    await rm(path.join(session.checkpointDir, "files", "a.txt"));
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(session.checkpointDir, "files", "a.txt"),
    );
    expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("current");
  });
});

test("invalid later manifest entries cannot partially restore earlier files", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), "original");
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    const manifest = await finalizeCheckpoint(session);
    await writeFile(path.join(root, "a.txt"), "current");
    await writeFile(
      path.join(session.checkpointDir, "manifest.json"),
      JSON.stringify({
        ...manifest,
        files: [...manifest.files, { path: "../outside.txt", existed: false }],
      }),
    );
    expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("current");
  });
});

test("manifest identity and backup paths are validated before any restore", async () => {
  for (const change of ["workspace", "backup"] as const) {
    await fixture(async (root, outside) => {
      await writeFile(path.join(root, "a.txt"), "original");
      const session = await createCheckpointSession(root);
      await ensureCheckpointBackup(session, "a.txt");
      const manifest = await finalizeCheckpoint(session);
      await writeFile(path.join(root, "a.txt"), "current");
      await writeFile(
        path.join(session.checkpointDir, "manifest.json"),
        JSON.stringify({
          ...manifest,
          ...(change === "workspace"
            ? { workspaceRoot: outside }
            : {
                files: manifest.files.map((file) => ({
                  ...file,
                  backupRelPath: "files/../outside.txt",
                })),
              }),
        }),
      );
      expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("current");
    });
  }
});

test("colliding human-readable roots neither share buckets nor restore or prune each other", async () => {
  await fixture(async (root) => {
    const a = path.join(root, "a-b", "c");
    const b = path.join(root, "a", "b-c");
    await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })]);
    await writeFile(path.join(a, "same.txt"), "A-original");
    await writeFile(path.join(b, "same.txt"), "B-original");
    const session = await createCheckpointSession(a, "run-a");
    await ensureCheckpointBackup(session, "same.txt");
    await finalizeCheckpoint(session);
    expect(workspaceSlug(a) === workspaceSlug(b)).toBe(false);
    expect(await rejected(() => rollbackCheckpoint(b, session.runId))).toBe(true);
    await pruneSnapshots(b, 0);
    expect(await readFile(path.join(session.checkpointDir, "manifest.json"), "utf8")).toBeDefined();
    expect(await readFile(path.join(b, "same.txt"), "utf8")).toBe("B-original");
  });
});

test("rollback replaces a hardlinked target without truncating the outside inode", async () => {
  await fixture(async (root, outside) => {
    await writeFile(path.join(root, "a.txt"), "original");
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    await finalizeCheckpoint(session);
    await rm(path.join(root, "a.txt"));
    await writeFile(path.join(outside, "same-inode.txt"), "OUTSIDE");
    await link(path.join(outside, "same-inode.txt"), path.join(root, "a.txt"));
    await rollbackCheckpoint(root, session.runId);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("original");
    expect(await readFile(path.join(outside, "same-inode.txt"), "utf8")).toBe("OUTSIDE");
  });
});

test("new sessions preserve read-only legacy project snapshots and valid rollback", async () => {
  await fixture(async (root) => {
    const legacy = path.join(root, ".openhorn", "snapshots", "legacy-run");
    await mkdir(path.join(legacy, "files"), { recursive: true });
    const manifest = {
      runId: "legacy-run",
      createdAt: new Date().toISOString(),
      files: [{ path: "a.txt", existed: true, backupRelPath: "files/a.txt" }],
    };
    const raw = JSON.stringify(manifest);
    await writeFile(path.join(legacy, "manifest.json"), raw);
    await writeFile(path.join(legacy, "files", "a.txt"), "legacy-original");
    await writeFile(path.join(root, "a.txt"), "current");
    await createCheckpointSession(root);
    expect(await readFile(path.join(legacy, "manifest.json"), "utf8")).toBe(raw);
    await rollbackCheckpoint(root, manifest.runId);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("legacy-original");
    expect(await readFile(path.join(legacy, "manifest.json"), "utf8")).toBe(raw);
  });
});

test("rollback preserves existing executable permission bits", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "script.sh");
    await writeFile(file, "original");
    await chmod(file, 0o751);
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "script.sh");
    await finalizeCheckpoint(session);
    await writeFile(file, "current");
    await rollbackCheckpoint(root, session.runId);
    expect(await readFile(file, "utf8")).toBe("original");
    expect((await stat(file)).mode & 0o777).toBe(0o751);
  });
});

test("legacy home checkpoints require an explicit matching workspace identity and stay untouched", async () => {
  for (const scoped of [false, true]) {
    await fixture(async (root) => {
      const oldBucket = root.replace(/^([a-zA-Z]):/, "$1").replace(/[\\/]/g, "-");
      const legacy = path.join(
        process.env.OPENHORN_HOME as string,
        "snapshots",
        oldBucket,
        "old-home",
      );
      await mkdir(path.join(legacy, "files"), { recursive: true });
      const raw = JSON.stringify({
        runId: "old-home",
        createdAt: new Date().toISOString(),
        ...(scoped ? { workspaceRoot: root } : {}),
        files: [{ path: "a.txt", existed: true, backupRelPath: "files/a.txt" }],
      });
      await writeFile(path.join(legacy, "manifest.json"), raw);
      await writeFile(path.join(legacy, "files", "a.txt"), "original");
      await writeFile(path.join(root, "a.txt"), "current");
      expect(await rejected(() => rollbackCheckpoint(root, "old-home"))).toBe(!scoped);
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
        scoped ? "original" : "current",
      );
      expect(await readFile(path.join(legacy, "manifest.json"), "utf8")).toBe(raw);
    });
  }
});

test("missing later backups are discovered before earlier files are restored", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), "a-original");
    await writeFile(path.join(root, "b.txt"), "b-original");
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "a.txt");
    await ensureCheckpointBackup(session, "b.txt");
    await finalizeCheckpoint(session);
    await writeFile(path.join(root, "a.txt"), "a-current");
    await writeFile(path.join(root, "b.txt"), "b-current");
    await rm(path.join(session.checkpointDir, "files", "b.txt"));
    expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("a-current");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("b-current");
  });
});

test("pruning preserves an active backup while removing completed owned snapshots", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), "original");
    const active = await createCheckpointSession(root, "active-run");
    await ensureCheckpointBackup(active, "a.txt");
    const complete = await createCheckpointSession(root, "complete-run");
    await finalizeCheckpoint(complete);
    await pruneSnapshots(root, 0);
    expect(await rejected(() => readFile(path.join(complete.checkpointDir, "manifest.json")))).toBe(
      true,
    );
    expect(await readFile(path.join(active.checkpointDir, "files", "a.txt"), "utf8")).toBe(
      "original",
    );
    await finalizeCheckpoint(active);
    await writeFile(path.join(root, "a.txt"), "current");
    await rollbackCheckpoint(root, active.runId);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("original");
  });
});

test("concurrent backups of one file share the first immutable snapshot", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "a.txt"), "original");
    const session = await createCheckpointSession(root);
    await Promise.all(Array.from({ length: 8 }, () => ensureCheckpointBackup(session, "a.txt")));
    await writeFile(path.join(root, "a.txt"), "changed");
    await ensureCheckpointBackup(session, "a.txt");
    await finalizeCheckpoint(session);
    await rollbackCheckpoint(root, session.runId);
    expect(session.files.size).toBe(1);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("original");
  });
});

test("long legal Unicode workspace names produce bounded buckets and binary round trips", async () => {
  const owned = await realpath(
    await mkdtemp(
      path.join(process.platform === "win32" ? tmpdir() : "/tmp", "openhorn-cp-unicode-"),
    ),
  );
  const previous = process.env.OPENHORN_HOME;
  process.env.OPENHORN_HOME = path.join(owned, "state");
  try {
    const root = path.join(owned, "旅".repeat(70));
    await mkdir(root);
    const bucketBytes = Buffer.byteLength(workspaceSlug(root), "utf8");
    const original = Buffer.from([0, 255, 128, 10]);
    await writeFile(path.join(root, "binary.dat"), original);
    const session = await createCheckpointSession(root);
    expect(bucketBytes <= 161).toBe(true);
    await ensureCheckpointBackup(session, "binary.dat");
    await finalizeCheckpoint(session);
    await writeFile(path.join(root, "binary.dat"), "current");
    await rollbackCheckpoint(root, session.runId);
    expect((await readFile(path.join(root, "binary.dat"))).toString("hex")).toBe(
      original.toString("hex"),
    );
  } finally {
    if (previous === undefined) delete process.env.OPENHORN_HOME;
    else process.env.OPENHORN_HOME = previous;
    await rm(owned, { recursive: true, force: true });
  }
});

if (process.platform !== "win32") {
  for (const scenario of ["manifest", "backup"]) {
    test(`rollback rejects a ${scenario} FIFO without hanging or partial file mutation`, async () => {
      const owned = await mkdtemp(path.join(tmpdir(), "openhorn-checkpoint-fifo-"));
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./checkpoints.fifo.fixture.ts", import.meta.url).pathname,
          owned,
          scenario,
        ],
        {
          env: { ...process.env, OPENHORN_HOME: path.join(owned, "state") },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Owned FIFO fixture timed out")), 4000);
          }),
        ]);
        expect(code).toBe(0);
        expect(await errors).toBe("");
        expect(JSON.parse(await out)).toEqual({
          state: "rejected",
          a: "a.txt-current",
          b: "b.txt-current",
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
        await Promise.all([out, errors]);
        await rm(owned, { recursive: true, force: true });
      }
    }, 6000);
  }
}

test("invalid stored permission modes reject before restoring any content", async () => {
  for (const mode of [-1, 0o1000, 1.5, "0600", null]) {
    await fixture(async (root) => {
      await writeFile(path.join(root, "a.txt"), "original");
      const session = await createCheckpointSession(root);
      await ensureCheckpointBackup(session, "a.txt");
      const manifest = await finalizeCheckpoint(session);
      await writeFile(path.join(root, "a.txt"), "current");
      await writeFile(
        path.join(session.checkpointDir, "manifest.json"),
        JSON.stringify({ ...manifest, files: manifest.files.map((file) => ({ ...file, mode })) }),
      );
      expect(await rejected(() => rollbackCheckpoint(root, session.runId))).toBe(true);
      expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("current");
    });
  }
});

if (process.platform !== "win32") {
  for (const scenario of ["private", "executable", "legacy", "legacy-declared"]) {
    test(`missing ${scenario} target restores safe permissions under a private umask`, async () => {
      const owned = await mkdtemp(path.join(tmpdir(), "openhorn-checkpoint-mode-"));
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./checkpoints.permissions.fixture.ts", import.meta.url).pathname,
          owned,
          scenario,
        ],
        {
          env: { ...process.env, OPENHORN_HOME: path.join(owned, "state") },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      try {
        expect(await child.exited).toBe(0);
        expect(await errors).toBe("");
        expect(JSON.parse(await out)).toEqual({
          content: "original",
          mode: scenario === "executable" ? 0o751 : 0o600,
        });
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
        await Promise.all([out, errors]);
        await rm(owned, { recursive: true, force: true });
      }
    });
  }
}
