import { toast } from 'sonner';

const lastShownAt = new Map<string, number>();

export function hideNotification(_id: string) {
  // sonner handles its own dismissal
}

export function notifyErrorOnce(key: string, title: string, message: string, ttlMs = 10_000) {
  const now = Date.now();
  const prev = lastShownAt.get(key) ?? 0;
  if (now - prev < ttlMs) return;
  lastShownAt.set(key, now);
  toast.error(title, { description: message, id: key });
}

export function notifyError(title: string, message: string) {
  if (typeof message === 'string' && message.toLowerCase().includes('failed to fetch')) {
    notifyErrorOnce('backend_down', '后端不可用', '无法连接到后端服务（http://localhost:3000）。请启动 server 后点击「重试」。');
    return;
  }
  toast.error(title, { description: message });
}

export function notifySuccess(title: string, message: string) {
  toast.success(title, { description: message });
}

export function notifyWarning(title: string, message: string) {
  toast.warning(title, { description: message });
}
