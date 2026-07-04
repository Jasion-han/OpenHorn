import { useEffect } from "react";

import {
  applyThemeMode,
  readThemeMode,
  THEME_MODE_CHANGE_EVENT,
  THEME_MODE_STORAGE_KEY,
} from "../../lib/theme";

export function ThemeListener() {
  useEffect(() => {
    const applyFromStorage = () => {
      applyThemeMode(readThemeMode());
    };

    // Re-broadcast after applying so components that derive state from the
    // root `dark` class (e.g. syntax highlighting theme) recompute. Only the
    // storage/media paths dispatch — onCustom must not, or it would loop.
    const applyAndNotify = () => {
      applyFromStorage();
      window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT));
    };

    applyFromStorage();

    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_MODE_STORAGE_KEY) applyAndNotify();
    };

    const onCustom = () => applyFromStorage();

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => {
      if (readThemeMode() === "system") applyAndNotify();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(THEME_MODE_CHANGE_EVENT, onCustom);
    media?.addEventListener?.("change", onMedia);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(THEME_MODE_CHANGE_EVENT, onCustom);
      media?.removeEventListener?.("change", onMedia);
    };
  }, []);

  return null;
}
