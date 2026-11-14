/** Provider-provided links are data. Never turn a different scheme into HTTPS. */
export function safeWebReference(value: string | undefined): string | null {
  if (!value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
