import type { DataTransferImportErrorCode } from "shared/types";
import { dataTransferLabels, getDataTransferLabel } from "./i18n/agent";

export const IMPORT_ERROR_LABELS = {
  import_invalid_request: "settings.data.import.error.invalidRequest",
  import_file_not_found: "settings.data.import.error.fileNotFound",
  import_file_unreadable: "settings.data.import.error.fileUnreadable",
  import_invalid_archive: "settings.data.import.error.invalidArchive",
  import_format_mismatch: "settings.data.import.error.formatMismatch",
  import_unsupported_format: "settings.data.import.error.unsupportedFormat",
  import_connection_failed: "settings.data.import.error.connectionFailed",
  import_failed: "settings.data.import.error.failed",
} as const satisfies Record<DataTransferImportErrorCode, string>;

export function isDataTransferImportErrorCode(
  value: unknown,
): value is DataTransferImportErrorCode {
  return typeof value === "string" && Object.hasOwn(IMPORT_ERROR_LABELS, value);
}

export class DataTransferImportError extends Error {
  constructor(
    readonly code: DataTransferImportErrorCode,
    legacyMessage?: string,
  ) {
    super(legacyMessage || code);
    this.name = "DataTransferImportError";
  }
}

/** No raw-text translation. Missing/new dictionary entries use an existing safe label. */
export function importErrorLabel(error: unknown): Parameters<typeof getDataTransferLabel>[0] {
  const code =
    error instanceof DataTransferImportError
      ? error.code
      : isDataTransferImportErrorCode(error)
        ? error
        : "import_failed";
  const key = IMPORT_ERROR_LABELS[code];
  return Object.hasOwn(dataTransferLabels, key)
    ? (key as Parameters<typeof getDataTransferLabel>[0])
    : "settings.data.import.failedTitle";
}

export class BackupSizeLimitError extends Error {
  readonly code = "backup_size_limit";
  constructor() {
    super("backup_size_limit");
  }
}
export function dataTransferErrorMessage(error: unknown): string {
  if (error instanceof DataTransferImportError)
    return getDataTransferLabel(importErrorLabel(error));
  if (error instanceof BackupSizeLimitError)
    return getDataTransferLabel("settings.data.export.sizeLimit");
  return error instanceof Error ? error.message : String(error);
}
