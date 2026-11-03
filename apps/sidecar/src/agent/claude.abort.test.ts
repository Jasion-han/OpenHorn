import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Fix 1 regression: when a Claude run aborts or throws mid-stream after it has
// already backed up files, the checkpoint must still be finalized so a later
// rollbackCheckpoint() can read manifest.json instead of failing with ENOENT.
//
// The Anthropic SDK is mocked (via mock.module, before ./claude is imported)
// with a fake client whose `messages.stream()` returns a stream that rejects
// on `finalMessage()` — simulating an AbortError partway through the stream.
describe("runClaudeAgent checkpoint finalize on abort", () => {
  test("aborted run still leaves a readable manifest that rollback can restore", async () => {
    const owned = mkdtempSync(path.join(os.tmpdir(), "openhorn-abort-owned-"));
    const previousHome = process.env.OPENHORN_HOME;
    process.env.OPENHORN_HOME = owned;
    try {
      const abortErr = Object.assign(new Error("Aborted"), { name: "AbortError" });
      const abortController = new AbortController();
      mock.module("@anthropic-ai/sdk", () => ({
        default: class MockAnthropic {
          messages = {
            stream: () => {
              const obj = {
                on(_event: string, _callback: unknown) {
                  return obj;
                },
                finalMessage: () => {
                  abortController.abort();
                  return Promise.reject(abortErr);
                },
                controller: new AbortController(),
              };
              return obj;
            },
          };
        },
      }));

      const { runClaudeAgent } = await import("./claude");
      const { createCheckpointSession, ensureCheckpointBackup, rollbackCheckpoint } = await import(
        "../checkpoints"
      );
      const { canonicalizeWorkspaceRoot } = await import("../workspace");

      const rootPath = path.join(owned, "workspace");
      mkdirSync(rootPath);
      const root = await canonicalizeWorkspaceRoot(rootPath);
      const filePath = path.join(root, "a.txt");
      writeFileSync(filePath, "v1", "utf8");

      // A checkpoint backup was recorded for this run (as the PreToolUse hook would).
      const checkpoint = await createCheckpointSession(root);
      await ensureCheckpointBackup(checkpoint, "a.txt");

      // The tool already edited the file before the run was aborted.
      writeFileSync(filePath, "v2", "utf8");

      let checkpointReadyRunId = "";

      let threw = false;
      try {
        await runClaudeAgent({
          apiKey: "test-key",
          model: "claude-sonnet-4",
          prompt: "hello",
          cwd: root,
          abortController,
          checkpoint,
          webSearchEnabled: false,
          requestApproval: async () => true,
          onEvent: () => {},
          onCheckpointReady: (runId) => {
            checkpointReadyRunId = runId;
          },
          onSdkSessionId: () => {},
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(checkpointReadyRunId).toBe(checkpoint.runId);

      // The manifest was written despite the abort, so rollback works.
      await rollbackCheckpoint(root, checkpoint.runId);
      expect(readFileSync(filePath, "utf8")).toBe("v1");
    } finally {
      if (previousHome === undefined) delete process.env.OPENHORN_HOME;
      else process.env.OPENHORN_HOME = previousHome;
      rmSync(owned, { recursive: true, force: true });
    }
  });
});
