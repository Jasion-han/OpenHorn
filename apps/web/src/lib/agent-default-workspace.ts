export const DEFAULT_WORKSPACE_SETTING_KEY = 'agent.defaultWorkspaceId';

export function pickDefaultWorkspaceId(
  workspaces: Array<{ id: string }>,
  candidateId: string | null | undefined
): string | null {
  const candidate = typeof candidateId === 'string' ? candidateId : null;
  if (candidate && workspaces.some((ws) => ws.id === candidate)) {
    return candidate;
  }
  return workspaces[0]?.id ?? null;
}

