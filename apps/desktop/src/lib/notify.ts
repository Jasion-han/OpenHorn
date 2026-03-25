import { type ExternalToast, toast } from "ui";
import { getDesktopBackendBase } from "./backendBase";

const lastShownAt = new Map<string, number>();

type NotifyOptions = Omit<ExternalToast, "description">;

function isLikelyBrowserFetchFailure(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  return /^(typeerror:\s*)?failed to fetch$/i.test(normalized);
}

export function notifyErrorOnce(key: string, title: string, message: string, ttlMs = 10_000) {
  const now = Date.now();
  const prev = lastShownAt.get(key) ?? 0;
  if (now - prev < ttlMs) return;
  lastShownAt.set(key, now);
  toast.error(title, { description: message, id: key });
}

export function notifyError(title: string, message: string, options?: NotifyOptions) {
  if (typeof message === "string" && isLikelyBrowserFetchFailure(message)) {
    notifyErrorOnce(
      "backend_down",
      "后端不可用",
      `无法连接到后端服务（${getDesktopBackendBase()}）。请启动 server 后点击「重试」。`,
    );
    return;
  }

  toast.error(title, { description: message, ...options });
}

export function notifySuccess(title: string, message: string, options?: NotifyOptions) {
  toast.success(title, { description: message, ...options });
}

export function notifyWarning(title: string, message: string, options?: NotifyOptions) {
  toast.warning(title, { description: message, ...options });
}
