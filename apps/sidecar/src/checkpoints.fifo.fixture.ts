// A blocked pre-fix FIFO reader is confined to this disposable process.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createCheckpointSession,
  ensureCheckpointBackup,
  finalizeCheckpoint,
  rollbackCheckpoint,
} from "./checkpoints";

const [ownedInput, scenario] = process.argv.slice(2);
const owned = await realpath(ownedInput);
const workspace = path.join(owned, "workspace");
process.env.OPENHORN_HOME = path.join(owned, "state");
await mkdir(workspace);
for (const name of ["a.txt", "b.txt"])
  await writeFile(path.join(workspace, name), `${name}-original`);
const session = await createCheckpointSession(workspace);
for (const name of ["a.txt", "b.txt"]) await ensureCheckpointBackup(session, name);
await finalizeCheckpoint(session);
for (const name of ["a.txt", "b.txt"])
  await writeFile(path.join(workspace, name), `${name}-current`);
const target =
  scenario === "manifest"
    ? path.join(session.checkpointDir, "manifest.json")
    : path.join(session.checkpointDir, "files", "b.txt");
await rm(target);
execFileSync("mkfifo", [target]);
const state = await Promise.race([
  rollbackCheckpoint(workspace, session.runId).then(
    () => "restored",
    () => "rejected",
  ),
  Bun.sleep(250).then(() => "pending"),
]);
console.log(
  JSON.stringify({
    state,
    a: await readFile(path.join(workspace, "a.txt"), "utf8"),
    b: await readFile(path.join(workspace, "b.txt"), "utf8"),
  }),
);
process.exit(0);
