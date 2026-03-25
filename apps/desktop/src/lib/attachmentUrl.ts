import { getDesktopBackendBase } from "./backendBase";

export function getAttachmentUrl(id: string, options?: { download?: boolean }) {
  const dl = options?.download ? "?download=1" : "";
  return `${getDesktopBackendBase()}/attachments/${encodeURIComponent(id)}${dl}`;
}
