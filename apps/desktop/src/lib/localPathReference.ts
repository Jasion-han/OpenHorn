import { getPreviewLabel } from "./i18n/agent";
import { parseFileReference } from "./referenceLink";

/** Recognize a whole inline-code path, never a command containing a path. */
export function parseInlineLocalPath(source: string) {
  if (!source || /[\r\n]/.test(source)) return;
  let value = source.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return;
      value = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
    } catch {
      return;
    }
  }
  if (!/^(?:\/|~\/|[a-z]:[\\/])/i.test(value)) return;
  if (/\s--?\S|&&|\|\||[;|]|\$\(/.test(value)) return;
  if (/\s(?:~\/|\/|[a-z]:[\\/])/i.test(value)) return;
  if (/^\/(?:s?bin|usr\/(?:local\/)?s?bin|opt\/homebrew\/bin)\/.*\s/.test(value)) return;
  return parseFileReference(value);
}

export function localPathErrorLabel(reason: unknown): string {
  const labels = {
    not_found: "preview.local.notFound",
    permission_denied: "preview.local.permissionDenied",
    not_absolute: "preview.local.notAbsolute",
    not_file: "preview.local.notFile",
    too_large: "preview.local.largeFile",
    unsupported_open: "preview.local.unsupportedOpen",
    unavailable: "preview.local.unavailable",
    main_view_only: "preview.local.permissionDenied",
  } as const;
  const code = typeof reason === "string" ? reason : "unavailable";
  return getPreviewLabel(
    code in labels ? labels[code as keyof typeof labels] : "preview.local.unavailable",
  );
}
