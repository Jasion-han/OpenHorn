import { getDataTransferLabel } from "./i18n/agent";

export class BackupSizeLimitError extends Error {
  readonly code = "backup_size_limit";
  constructor() {
    super("backup_size_limit");
  }
}
export function dataTransferErrorMessage(error: unknown): string {
  if (error instanceof BackupSizeLimitError)
    return getDataTransferLabel("settings.data.export.sizeLimit");
  return error instanceof Error ? error.message : String(error);
}
