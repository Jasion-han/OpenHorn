import { Transform } from "node:stream";

export const BACKUP_ARCHIVE_LIMITS = {
  entryBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  entries: 20_000,
} as const;

export class BackupSizeLimitError extends Error {
  readonly code = "backup_size_limit";
  constructor() {
    super("backup_size_limit");
  }
}

/** Both metadata and attachment streams contribute their actual uncompressed bytes. */
export class BackupArchiveBudget {
  private total = 0;
  private names = new Set<string>();

  addEntry(name: string, size: number) {
    if (
      this.names.has(name) ||
      this.names.size >= BACKUP_ARCHIVE_LIMITS.entries ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > BACKUP_ARCHIVE_LIMITS.entryBytes ||
      this.total + size > BACKUP_ARCHIVE_LIMITS.totalBytes
    )
      throw new BackupSizeLimitError();
    this.names.add(name);
    this.total += size;
  }

  attachment(name: string): Transform {
    // Reserve its name now; account for bytes as they arrive.
    this.addEntry(name, 0);
    let entryBytes = 0;
    return new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        entryBytes += chunk.length;
        this.total += chunk.length;
        if (
          entryBytes > BACKUP_ARCHIVE_LIMITS.entryBytes ||
          this.total > BACKUP_ARCHIVE_LIMITS.totalBytes
        )
          return done(new BackupSizeLimitError());
        done(null, chunk);
      },
    });
  }
}
