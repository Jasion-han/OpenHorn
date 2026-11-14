/** Stable import failures. HTTP 200 ImportResult warnings remain result data. */
export type DataTransferImportErrorCode =
  | "import_invalid_request"
  | "import_file_not_found"
  | "import_file_unreadable"
  | "import_invalid_archive"
  | "import_format_mismatch"
  | "import_unsupported_format"
  | "import_connection_failed"
  | "import_failed";

export interface DataTransferImportErrorResponse {
  errorCode: DataTransferImportErrorCode;
  /** Retained for older clients; localized UI must use errorCode instead. */
  error: string;
}
