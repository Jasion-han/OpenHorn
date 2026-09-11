/**
 * Pure helpers shared by the web preview tab and the panel that hosts it.
 * Kept out of the component files on purpose: a module that exports both
 * components and plain functions cannot be Fast Refreshed, and a full reload
 * blanks the Tauri webview.
 */

const LABEL_PREFIX = "preview-";

/** Tauri webview label for a preview tab (`preview-<tabId>`). */
export function previewWebviewLabel(tabId: string): string {
  return `${LABEL_PREFIX}${tabId}`;
}

/** Inverse of `previewWebviewLabel`; `null` for labels that are not ours. */
export function previewTabIdFromLabel(label: string): string | null {
  return label.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : null;
}

/** Address-bar input → navigable URL (`example.com` becomes `https://example.com`). */
export function normalizeAddressInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // Anything that already carries a scheme other than http(s) (file:,
  // javascript:, …) is refused rather than turned into `https://file///…`.
  // `localhost:3000` is host:port, not a scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(value)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  const withScheme = scheme ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
