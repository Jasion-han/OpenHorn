// Permission restoration changes umask only in this owned disposable process.
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createCheckpointSession,
  ensureCheckpointBackup,
  finalizeCheckpoint,
  rollbackCheckpoint,
} from "./checkpoints";

const [ownedInput, scenario] = process.argv.slice(2);
const owned = await realpath(ownedInput);
const root = path.join(owned, "workspace");
process.env.OPENHORN_HOME = path.join(owned, "state");
await mkdir(root);
const previousMask = process.umask(0o077);
try {
  const target = path.join(root, "file.txt");
  let runId: string;
  if (scenario.startsWith("legacy")) {
    runId = "legacy-permissions";
    const legacy = path.join(root, ".openhorn", "snapshots", runId);
    await mkdir(path.join(legacy, "files"), { recursive: true });
    await writeFile(path.join(legacy, "files", "file.txt"), "original");
    await writeFile(
      path.join(legacy, "manifest.json"),
      JSON.stringify({
        runId,
        createdAt: new Date().toISOString(),
        files: [
          {
            path: "file.txt",
            existed: true,
            backupRelPath: "files/file.txt",
            ...(scenario === "legacy-declared" ? { mode: 0o777 } : {}),
          },
        ],
      }),
    );
  } else {
    await writeFile(target, "original");
    await chmod(target, scenario === "private" ? 0o600 : 0o751);
    const session = await createCheckpointSession(root);
    await ensureCheckpointBackup(session, "file.txt");
    await finalizeCheckpoint(session);
    runId = session.runId;
    await rm(target);
  }
  await rollbackCheckpoint(root, runId);
  console.log(
    JSON.stringify({
      content: await readFile(target, "utf8"),
      mode: (await stat(target)).mode & 0o777,
    }),
  );
} finally {
  process.umask(previousMask);
}
