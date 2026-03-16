export type CommandRisk = {
  level: 'allow' | 'confirm';
  reason?: string;
};

export function classifyBashCommandRisk(command: string): CommandRisk {
  const raw = command.trim();
  if (!raw) return { level: 'confirm', reason: 'Empty command' };

  const lower = raw.toLowerCase();

  if (/(^|\s)sudo(\s|$)/.test(lower)) {
    return { level: 'confirm', reason: 'Uses sudo' };
  }

  if (/(^|\s)rm(\s)+-rf(\s|$)/.test(lower) || /(^|\s)rm(\s)+-r(\s)+-f(\s|$)/.test(lower)) {
    return { level: 'confirm', reason: 'rm -rf is high risk' };
  }

  if (/(^|\s)(mkfs|dd)(\s|$)/.test(lower)) {
    return { level: 'confirm', reason: 'Disk operations are high risk' };
  }

  if (/(^|\s)chmod(\s|$)|(^|\s)chown(\s|$)/.test(lower)) {
    return { level: 'confirm', reason: 'Permission changes are high risk' };
  }

  if (/(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/.test(lower)) {
    return { level: 'confirm', reason: 'Piping download into shell is high risk' };
  }

  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(lower)) {
    return { level: 'confirm', reason: 'Fork bomb pattern detected' };
  }

  return { level: 'allow' };
}

