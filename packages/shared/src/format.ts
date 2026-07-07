// Framework-agnostic, DOM-free formatting/string helpers shared across apps.
// Must not reference DOM-only globals/types (this module is also loaded by the
// Bun/Node server), so file-like inputs are described structurally.

/** Truncate a name to `max` chars, using an ellipsis suffix when it overflows. */
export function truncateName(name: string, max = 20): string {
  return name.length > max ? `${name.slice(0, max - 3)}...` : name;
}

/** Minimal structural shape of a browser File used for identity keying. */
export type FileIdentity = {
  name: string;
  size: number;
  lastModified: number;
};

/** Stable key for a file, used for de-duplication and as a React list key. */
export function fileKey(file: FileIdentity): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}
