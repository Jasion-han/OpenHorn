import { beforeAll, expect, test } from "bun:test";

// A separate process owns a real temporary SQLite database and attachment directory.
// No process-global db/route mocks can make these checks pass accidentally.
// biome-ignore lint/suspicious/noExplicitAny: serialized fixture includes HTTP DTOs and raw SQLite rows
let observed: Record<string, any>;
beforeAll(() => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./deepseekImport.fixture.ts", import.meta.url).pathname],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  observed = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "{}");
});

test("detects DeepSeek v3, validates real OpenHorn manifests, and preserves legacy JSON detection", () => {
  expect(observed.detection).toEqual({
    deepseek: "deepseek",
    openhorn: "openhorn",
    bogus: "unknown",
    version: "unknown",
    malformed: "unknown",
    hybrid: "unknown",
    chatgpt: "chatgpt",
    claude: "claude",
  });
});

test("imports the current branch with exact text, timestamps, thinking and search steps", () => {
  expect(observed.first.status).toBe(200);
  expect(observed.first.body.conversations).toEqual({ imported: 1, skipped: 0 });
  expect(observed.first.body.messages).toEqual({ imported: 2 });
  expect(observed.saved?.title).toBe("Current branch");
  expect(observed.saved?.created_at).toBe(1700000000);
  expect(observed.saved?.updated_at).toBe(1700000060);
  expect(observed.saved?.imported_from).toBe("file");
  expect(observed.savedMessages?.map((m) => m.content)).toEqual(["hello world", "first\nlast"]);
  expect(observed.savedMessages?.map((m) => m.created_at)).toEqual([1700000001, 1700000002]);
  expect(observed.steps?.map((s) => s.type)).toEqual([
    "thinking",
    "tool_start",
    "tool_result",
    "text",
  ]);
  expect(observed.steps?.[0].content).toBe("careful thought");
  expect(observed.steps?.[2].content.includes("https://example.com/source")).toBe(true);
});

test("records missing attachments and unsupported branches honestly in file/deepseek-export history", () => {
  expect(observed.first.body.attachments).toEqual({ imported: 0, missing: 1 });
  expect(observed.first.body.errors.some((e: string) => e.includes("branch"))).toBe(true);
  expect(observed.history?.source).toBe("file");
  expect(observed.history?.kind).toBe("deepseek-export");
  expect(observed.history?.totalNeedsAction > 0).toBe(true);
  expect(observed.noConfigImported).toBe(true);
  expect(observed.attachmentRows).toBe(0);
});

test("dedupes changed ZIPs and concurrent imports without overwriting existing history", () => {
  expect(observed.again.body.conversations).toEqual({ imported: 0, skipped: 1 });
  expect(observed.changed.body.conversations).toEqual({ imported: 0, skipped: 1 });
  expect(observed.editedTitle).toBe("Locally edited");
  expect(observed.concurrent.map((r) => r.status)).toEqual([200, 200]);
  expect(observed.concurrent.map((r) => r.body.conversations.imported).sort()).toEqual([0, 1]);
  expect(observed.concurrent.map((r) => r.body.conversations.skipped).sort()).toEqual([0, 1]);
  expect(observed.concurrentRows).toBe(1);
});

test("SQL identity survives restart and scopes the same DeepSeek session id to each user", () => {
  expect(observed.otherUser?.conversations).toEqual({ imported: 1, skipped: 0 });
  expect(observed.otherIdentity !== observed.saved?.id).toBe(true);
  expect(observed.otherHistoryInvisible).toBe(true);
  expect(observed.restarted?.conversations).toEqual({ imported: 0, skipped: 1 });
  expect(observed.crossProcess.map((r) => r.conversations.imported).sort()).toEqual([0, 1]);
  expect(observed.crossProcess.map((r) => r.conversations.skipped).sort()).toEqual([0, 1]);
  expect(observed.crossProcess.every((r) => typeof r.recordId === "string")).toBe(true);
});

test("rejects bad manifest/index/tree/fragment/path archives before writing any conversation", () => {
  expect(observed.invalid.length >= 12).toBe(true);
  for (const item of observed.invalid) {
    expect(item.imported).toBe(0);
    expect(item.hasError).toBe(true);
    expect(item.rows).toBe(0);
  }
});

test("cannot force an arbitrary import format to bypass detection", () => {
  expect(observed.forged.map((r) => r.status)).toEqual([400, 400, 400, 400]);
  expect(observed.directBackup.backupFailure).toBe("validation");
  expect(observed.forgedRows).toBe(0);
});

test("rolls back an entire conversation on SQL failure and retries cleanly", () => {
  expect(observed.failed.body.conversations.imported).toBe(0);
  expect(observed.failed.body.messages.imported).toBe(0);
  expect(observed.failedRows).toBe(0);
  expect(observed.failedMessages).toBe(0);
  expect(observed.failedFiles).toBe(0);
  expect(observed.retried.body.conversations.imported).toBe(1);
  expect(observed.retried.body.messages.imported).toBe(2);
});

test("restores actual image bytes under generated paths and links them to the owned message", () => {
  expect(observed.retried.body.attachments).toEqual({ imported: 1, missing: 0 });
  expect(observed.restoredImage).toBe(true);
  expect(observed.imagePathBounded).toBe(true);
  expect(observed.imageLinked).toBe(true);
});

test("retries wrapped SQLite lock failures before any conversation/files are written", () => {
  expect(observed.locked?.conversations).toEqual({ imported: 1, skipped: 0 });
});
