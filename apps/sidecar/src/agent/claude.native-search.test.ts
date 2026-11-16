import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("Claude Agent WebSearch retrieves through the selected independent native channel without replacing its model credentials", () => {
  const owned = mkdtempSync(path.join(tmpdir(), "openhorn-native-claude-"));
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        new URL("./claude.native-search.fixture.ts", import.meta.url).pathname,
        owned,
      ],
      {
        env: { ...process.env, OPENHORN_HOME: path.join(owned, "home") },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
    expect(JSON.parse(child.stdout.toString())).toEqual({
      nativeRequests: 1,
      modelRequests: 2,
      separatedCredentials: true,
    });
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
