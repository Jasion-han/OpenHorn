import { expect, test } from "bun:test";
import { useBackendStatusStore } from "../stores/backendStatusStore";
import {
  BackupSizeLimitError,
  DataTransferImportError,
  dataTransferErrorMessage,
  IMPORT_ERROR_LABELS,
  importErrorLabel,
  isDataTransferImportErrorCode,
} from "./dataTransferError";
import { dataTransferLabels, getDataTransferLabel } from "./i18n/agent";
import { createServerApi } from "./serverApi";

test("backup export turns a typed capacity response into actionable localized feedback", async () => {
  const previous = useBackendStatusStore.getState();
  try {
    const api = createServerApi({
      baseUrl: "http://synthetic.invalid",
      fetch: (async () =>
        Response.json({ errorCode: "backup_size_limit" }, { status: 413 })) as typeof fetch,
    });
    let error: unknown;
    try {
      await api.dataTransfer.exportBackup("/synthetic");
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof BackupSizeLimitError).toBe(true);
    expect(dataTransferErrorMessage(error)).toBe(
      getDataTransferLabel("settings.data.export.sizeLimit"),
    );
    expect(dataTransferErrorMessage(new Error("Synthetic failure"))).toBe("Synthetic failure");
  } finally {
    useBackendStatusStore.setState(previous, true);
  }
});

test("import failures use finite error codes and dictionary keys rather than translating raw text", () => {
  for (const [code, key] of Object.entries(IMPORT_ERROR_LABELS)) {
    expect(isDataTransferImportErrorCode(code)).toBe(true);
    if (!isDataTransferImportErrorCode(code)) throw new Error("Unknown fixture code");
    const error = new DataTransferImportError(code, "raw diagnostics must not become toast text");
    expect(Object.hasOwn(dataTransferLabels, key)).toBe(true);
    expect(importErrorLabel(error)).toBe(key);
    expect(dataTransferErrorMessage(error)).toBe(getDataTransferLabel(key));
    expect(dataTransferErrorMessage(error).trim().length > 0).toBe(true);
    expect(dataTransferErrorMessage(error) === error.message).toBe(false);
  }
  for (const code of ["__proto__", "constructor", "toString", "future_import_code", null, 123]) {
    expect(isDataTransferImportErrorCode(code)).toBe(false);
  }
  expect(importErrorLabel(new Error("Invalid import archive"))).toBe(
    importErrorLabel("import_failed"),
  );
  expect(importErrorLabel(new Error("import_file_not_found"))).toBe(
    importErrorLabel("import_failed"),
  );
});

test("new import transport handles legacy, non-JSON and unknown-code server failures", async () => {
  const previous = useBackendStatusStore.getState();
  try {
    for (const response of [
      Response.json({ error: "Legacy import error" }, { status: 400 }),
      Response.json({ errorCode: "constructor", error: "unsafe inherited name" }, { status: 400 }),
      Response.json({ errorCode: "future_import_error", error: "newer server" }, { status: 400 }),
      new Response("Legacy plain-text error", { status: 500 }),
    ]) {
      const api = createServerApi({
        baseUrl: "http://127.0.0.1",
        fetch: (async () => response) as typeof fetch,
      });
      let caught: unknown;
      try {
        await api.dataTransfer.detectFormat("/fixture.zip");
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof DataTransferImportError).toBe(true);
      expect(caught instanceof DataTransferImportError && caught.code).toBe("import_failed");
    }
  } finally {
    useBackendStatusStore.setState(previous, true);
  }
});

test("an error code in a successful import body or unrelated route is not treated as an import failure", async () => {
  const previous = useBackendStatusStore.getState();
  try {
    const successful = createServerApi({
      baseUrl: "http://127.0.0.1",
      fetch: (async () =>
        Response.json({ format: "openhorn", errorCode: "import_invalid_archive" })) as typeof fetch,
    });
    expect(await successful.dataTransfer.detectFormat("/fixture.zip")).toMatchObject({
      format: "openhorn",
    });
    const unrelated = createServerApi({
      baseUrl: "http://127.0.0.1",
      fetch: (async () =>
        Response.json(
          { errorCode: "import_invalid_archive", error: "Unrelated error" },
          { status: 400 },
        )) as typeof fetch,
    });
    let caught: unknown;
    try {
      await unrelated.conversations.list();
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof DataTransferImportError).toBe(false);
    expect(caught instanceof Error && caught.message).toBe("Unrelated error");
  } finally {
    useBackendStatusStore.setState(previous, true);
  }
});
