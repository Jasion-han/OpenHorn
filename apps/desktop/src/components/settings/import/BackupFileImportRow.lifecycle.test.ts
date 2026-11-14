import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DataTransferImportError, importErrorLabel } from "../../../lib/dataTransferError";

declare const Bun: {
  Transpiler: new (options: { loader: "tsx" }) => { transformSync(source: string): string };
};

// Execute the real submit handler; this checks async ownership and refresh
// effects without claiming that a mocked file picker is native acceptance.
const source = readFileSync(new URL("./BackupFileImportRow.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const confirmImport = useCallback(");
const end = source.indexOf("\n  return (", start);
const handler = source.slice(start, end);
const result = { format: "deepseek", conversations: { imported: 1, skipped: 0 } };

function harness() {
  let resolve!: (value: typeof result) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<typeof result>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const observed = { calls: 0, refreshes: 0, callbacks: 0, errors: [] as string[][] };
  const busy: boolean[] = [];
  const dialogs: boolean[] = [];
  const epoch = { current: 1 };
  const submission = { current: false };
  const completed = { current: false };
  const scope = {
    importFilePath: "/generated/qa.zip",
    detectedFormat: "deepseek",
    submission,
    completed,
    selectionEpoch: epoch,
    useCallback: (fn: () => Promise<void>) => fn,
    setImporting: (value: boolean) => busy.push(value),
    api: {
      dataTransfer: {
        importData: async () => {
          observed.calls++;
          return pending;
        },
      },
    },
    setImportResult: () => {},
    setImportDialogOpen: () => {},
    setImportResultDialogOpen: (value: boolean) => dialogs.push(value),
    refreshImportedResources: async () => {
      observed.refreshes++;
    },
    notifyError: (...args: string[]) => observed.errors.push(args),
    notifyWarning: () => {},
    notifySuccess: () => {},
    resultTitle: () => "result",
    hasWarnings: () => false,
    getDataTransferLabel: (key: string) => key,
    formatDataTransferLabel: (key: string) => key,
    importErrorLabel,
    onImported: () => {
      observed.callbacks++;
    },
  };
  const build = new Function(
    "scope",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(`
    const { ${Object.keys(scope).join(", ")} } = scope;
    ${handler}
    return confirmImport;
  `),
  ) as (scope: unknown) => () => Promise<void>;
  return { submit: build(scope), resolve, reject, observed, busy, dialogs, epoch, submission };
}

test("file import submits once while pending and refreshes resources once after success", async () => {
  const qa = harness();
  const first = qa.submit();
  const duplicate = qa.submit();
  expect(qa.observed.calls).toBe(1);
  qa.resolve(result);
  await Promise.all([first, duplicate]);
  await qa.submit();
  expect(qa.observed.calls).toBe(1);
  expect(qa.observed.refreshes).toBe(1);
  expect(qa.observed.callbacks).toBe(1);
  expect(qa.dialogs).toEqual([true]);
  expect(qa.busy).toEqual([true, false]);
});

test("completed import refreshes data but cannot open a result over a newer navigation", async () => {
  const qa = harness();
  const first = qa.submit();
  qa.epoch.current++;
  qa.resolve(result);
  await first;
  expect(qa.observed.refreshes).toBe(1);
  expect(qa.observed.callbacks).toBe(1);
  expect(qa.dialogs).toEqual([]);
  expect(qa.submission.current).toBe(false);
});

test("failed import preserves structured feedback and releases its submission guard", async () => {
  const qa = harness();
  const first = qa.submit();
  qa.reject(new DataTransferImportError("import_file_not_found"));
  await first;
  expect(qa.observed.refreshes).toBe(0);
  expect(qa.observed.errors).toEqual([
    ["settings.data.import.failedTitle", "settings.data.import.error.fileNotFound"],
  ]);
  expect(qa.submission.current).toBe(false);
  await qa.submit();
  expect(qa.observed.calls).toBe(2);
});
