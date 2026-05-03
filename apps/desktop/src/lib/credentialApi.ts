export interface CredentialSource {
  id: string;
  provider: "openai" | "anthropic" | "google";
  sourceType: "env_var" | "cli_oauth" | "manual";
  sourceName: string;
  status: "available" | "expired" | "error";
  error?: string;
}

export interface ProviderPreset {
  protocol: "openai" | "anthropic" | "google";
  baseUrl: string;
  name: string;
}

import { getDesktopBackendBase } from "./backendBase";

async function credentialFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await getDesktopBackendBase();
  return fetch(`${base}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

export async function listCredentialSources(): Promise<CredentialSource[]> {
  const res = await credentialFetch("/credentials/sources");
  if (!res.ok) return [];
  const data = await res.json();
  return data.sources ?? [];
}

export async function getCredentialKey(sourceId: string): Promise<string> {
  const res = await credentialFetch(`/credentials/sources/${sourceId}/key`);
  if (!res.ok) throw new Error(`Failed to fetch credential key: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.apiKey;
}

export async function testCredentialSource(
  sourceId: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await credentialFetch(`/credentials/sources/${sourceId}/test`, {
    method: "POST",
  });
  if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
  return res.json();
}

export async function getProviderPresets(): Promise<Record<string, ProviderPreset>> {
  const res = await credentialFetch("/credentials/presets");
  if (!res.ok) return {};
  const data = await res.json();
  return data.presets ?? {};
}
