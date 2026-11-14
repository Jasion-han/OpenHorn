import { beforeAll, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: mixed serialized HTTP and client transport observations
let report: Record<string, any>;
beforeAll(() => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      new URL("./dataTransfer.errors.fixture.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    },
  );
  if (child.exitCode !== 0) throw new Error(child.stderr.toString() + child.stdout.toString());
  report = JSON.parse(child.stdout.toString().trim().split("\n").at(-1) ?? "null");
});

test("real loopback HTTP emits stable import errors with the legacy error field", () => {
  expect(report.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  for (const [name, code] of Object.entries({
    missingDetect: "import_file_not_found",
    missingImport: "import_file_not_found",
    badZipDetect: "import_invalid_archive",
    badZipImport: "import_invalid_archive",
    directory: "import_file_unreadable",
    invalidBody: "import_invalid_request",
    invalidJson: "import_invalid_request",
    wrongPathType: "import_invalid_request",
    mismatch: "import_format_mismatch",
    unsupported: "import_unsupported_format",
  })) {
    expect(report.responses[name].status).toBe(400);
    expect(report.responses[name].body.errorCode).toBe(code);
    expect(typeof report.responses[name].body.error).toBe("string");
  }
  expect(report.responses.detectedUnknown).toEqual({ status: 200, body: { format: "unknown" } });
});

test("the desktop client parses only explicit data-transfer import paths and supports legacy servers", () => {
  expect(report.transported.missing.code).toBe("import_file_not_found");
  expect(report.transported.badZip.code).toBe("import_invalid_archive");
  expect(report.transported.mismatch.code).toBe("import_format_mismatch");
  expect(report.transported.legacy.code).toBe("import_failed");
  expect(report.transported.future.code).toBe("import_failed");
  expect(report.transported.unrelated.code).toBe(null);
  expect(report.transported.unrelated.message).toBe("Unrelated failure");
  expect(report.disconnected.code).toBe("import_connection_failed");
});

test("HTTP 200 partial/validation/interrupted import results remain result objects", () => {
  expect(report.validation.backupFailure).toBe("validation");
  expect(report.validation.conversations.imported).toBe(0);
  expect(report.partial.backupFailure).toBeUndefined();
  expect(report.partial.conversations.imported).toBe(1);
  expect(report.partial.attachments.missing).toBe(1);
  expect(report.interrupted.backupFailure).toBe("interrupted");
  expect(report.interrupted.conversations.imported).toBe(1);
});
