export function normalizeExternalUrl(raw: string | null | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "#";

  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).toString();
    } catch {
      return "#";
    }
  }

  // Avoid rendering relative URLs for external citations.
  try {
    return new URL(`https://${value}`).toString();
  } catch {
    return "#";
  }
}
