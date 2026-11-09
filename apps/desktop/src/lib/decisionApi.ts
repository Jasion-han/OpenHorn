import type { JevPreferences, JevStatus } from "shared/types";
import { getDesktopBackendBase } from "./backendBase";
import { fetchWithBackendStatus } from "./serverApi";

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchWithBackendStatus(`${getDesktopBackendBase()}/decisions${path}`, {
    method,
    signal,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error("Decision service unavailable");
  return (await response.json()) as T;
}
export const decisionApi = {
  status: (signal?: AbortSignal) =>
    request<
      JevStatus & { shadow?: { compared: number; disagreements: number; unavailable: number } }
    >("/status", "GET", undefined, signal),
  configure: (preferences: JevPreferences) => request<JevStatus>("/config", "PUT", preferences),
  skills: (prompt: string, skills: Array<{ name: string; description: string }>) =>
    request<{ preferredNames: string[] }>("/skills", "POST", { prompt, skills }),
};
