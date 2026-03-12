type SettingsTab = 'general' | 'channels' | 'agent';

export function buildSettingsLink(input?: {
  tab?: SettingsTab;
  focus?: 'default' | string;
}) {
  const tab = input?.tab || 'channels';
  const focus = input?.focus;
  const params = new URLSearchParams();
  params.set('tab', tab);
  if (focus) params.set('focus', focus);
  return `/settings?${params.toString()}`;
}

