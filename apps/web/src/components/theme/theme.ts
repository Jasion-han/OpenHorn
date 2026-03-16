export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODE_STORAGE_KEY = 'openhorn.themeMode';
export const THEME_MODE_CHANGE_EVENT = 'openhorn-theme-change';

export function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const raw = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
  if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  return 'light';
}

export function applyThemeMode(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const systemDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;

  const useDark = mode === 'dark' || (mode === 'system' && systemDark);
  if (useDark) root.classList.add('dark');
  else root.classList.remove('dark');
}
