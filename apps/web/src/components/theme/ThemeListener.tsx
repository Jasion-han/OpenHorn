"use client";

import { useEffect } from "react";
import {
  applyThemeMode,
  readThemeMode,
  THEME_MODE_CHANGE_EVENT,
  THEME_MODE_STORAGE_KEY,
} from "./theme";

export function ThemeListener() {
  useEffect(() => {
    const applyFromStorage = () => {
      applyThemeMode(readThemeMode());
    };

    applyFromStorage();

    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_MODE_STORAGE_KEY) applyFromStorage();
    };

    const onCustom = () => applyFromStorage();

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => {
      if (readThemeMode() === "system") applyFromStorage();
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
