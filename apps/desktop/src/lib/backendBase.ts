export const DEFAULT_DESKTOP_BACKEND_BASE = "http://localhost:3000";

function getEnvBase() {
  return (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE;
}

export function getDesktopBackendBase(): string {
  const envBase = getEnvBase();
  if (typeof envBase === "string" && envBase.trim()) {
    return envBase.trim();
  }

  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:3000";
  }

  return DEFAULT_DESKTOP_BACKEND_BASE;
}
