import { notifications } from '@mantine/notifications';

const lastShownAt = new Map<string, number>();

export function hideNotification(id: string) {
  try {
    notifications.hide(id);
  } catch {
    // Best-effort; ignore if notifications provider isn't ready.
  }
}

export function notifyErrorOnce(key: string, title: string, message: string, ttlMs = 10_000) {
  const now = Date.now();
  const prev = lastShownAt.get(key) ?? 0;
  if (now - prev < ttlMs) return;
  lastShownAt.set(key, now);
  notifications.show({
    id: key,
    color: 'red',
    title,
    message,
  });
}

export function notifyError(title: string, message: string) {
  // Common browser error for network failures / backend down.
  if (typeof message === 'string' && message.toLowerCase().includes('failed to fetch')) {
    notifyErrorOnce('backend_down', '后端不可用', '无法连接到后端服务（http://localhost:3000）。请启动 server 后点击 Retry。');
    return;
  }
  notifications.show({
    color: 'red',
    title,
    message,
  });
}

export function notifySuccess(title: string, message: string) {
  notifications.show({
    color: 'teal',
    title,
    message,
  });
}
