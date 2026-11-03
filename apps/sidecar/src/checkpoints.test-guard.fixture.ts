// Even a broken guard can touch only this synthetic user's owned state tree.
import { mock } from "bun:test";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import * as osNamespace from "node:os";
import path from "node:path";

const owned = await realpath(process.argv[2]);
const fakeHome = path.join(owned, "fake-user");
const protectedHome = path.join(fakeHome, ".openhorn");
const workspace = path.join(owned, "workspace");
const protectedSnapshots = path.join(protectedHome, "snapshots");
const derivedHome = path.join(owned, "derived-home");
await Promise.all([
  mkdir(protectedSnapshots, { recursive: true }),
  mkdir(workspace),
  mkdir(derivedHome),
]);
await symlink(protectedSnapshots, path.join(derivedHome, "snapshots"));
await writeFile(path.join(protectedHome, "sentinel"), "preserved");
const realOs = { ...osNamespace };
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => fakeHome,
  default: { ...realOs, homedir: () => fakeHome },
}));
const checkpoints = await import("./checkpoints");
delete process.env.OPENHORN_HOME;
const pureDefaultPath =
  checkpoints.resolveSnapshotsHome() === path.join(protectedHome, "snapshots");
if (!pureDefaultPath) {
  throw new Error("Synthetic default-home substitution failed; refuse unsafe fixture execution");
}
process.env.OPENHORN_HOME = path.join(owned, "isolated-state");
const session = await checkpoints.createCheckpointSession(workspace);
let rejected = 0;
for (const configured of [undefined, protectedHome, derivedHome]) {
  if (configured === undefined) delete process.env.OPENHORN_HOME;
  else process.env.OPENHORN_HOME = configured;
  for (const operation of [
    () => checkpoints.createCheckpointSession(workspace),
    () => checkpoints.ensureCheckpointBackup(session, "file.txt"),
    () => checkpoints.finalizeCheckpoint(session),
    () => checkpoints.rollbackCheckpoint(workspace, session.runId),
    () => checkpoints.pruneSnapshots(workspace, 0),
    () => checkpoints.discardCheckpointIfEmpty(session),
  ]) {
    try {
      await operation();
    } catch (error) {
      if ((error as { code?: string }).code === "unsafe_test_snapshot_home") rejected++;
    }
  }
}
console.log(
  JSON.stringify({
    rejected,
    sentinel: await readFile(path.join(protectedHome, "sentinel"), "utf8"),
    protectedEntries: (await readdir(protectedHome)).sort(),
    protectedSnapshotEntries: await readdir(protectedSnapshots),
    pureDefaultPath,
  }),
);
