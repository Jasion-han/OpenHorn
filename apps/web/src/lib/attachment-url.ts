import { API_BASE } from './api';

export function getAttachmentUrl(id: string, options?: { download?: boolean }) {
  const dl = options?.download ? '?download=1' : '';
  return `${API_BASE}/attachments/${encodeURIComponent(id)}${dl}`;
}

