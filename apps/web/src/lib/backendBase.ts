export const DEFAULT_BACKEND_BASE = "http://localhost:3000";

export function getBackendBase(): string {
  const env = process.env.NEXT_PUBLIC_API_BASE;
  if (typeof env === "string" && env.trim()) return env.trim();

  if (typeof window === "undefined") return DEFAULT_BACKEND_BASE;

  // Keep the default stable for "localhost-like" environments (including Tauri),
  // but align 127.0.0.1-based dev setups to avoid cookie/CORS surprises.
  if (window.location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:3000";
  }

  return DEFAULT_BACKEND_BASE;
}
