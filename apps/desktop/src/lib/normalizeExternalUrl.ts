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

  try {
    return new URL(`https://${value}`).toString();
  } catch {
    return "#";
  }
}
