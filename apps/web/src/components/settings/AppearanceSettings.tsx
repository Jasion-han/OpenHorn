"use client";

import { useEffect, useMemo, useState } from "react";
import { cn, SettingsCard, SettingsRow, SettingsSection, SettingsSegmentedControl } from "ui";
import type { ThemeMode } from "@/components/theme/theme";
import {
  applyThemeMode,
  readThemeMode,
  THEME_MODE_CHANGE_EVENT,
  THEME_MODE_STORAGE_KEY,
} from "@/components/theme/theme";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

function getZoomHint() {
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  return isMac
    ? "使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小"
    : "使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小";
}

export function AppearanceSettings() {
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");

  const zoomHint = useMemo(() => getZoomHint(), []);

  useEffect(() => {
    setThemeMode(readThemeMode());
  }, []);

  const handleThemeChange = (value: string) => {
    const next = (value as ThemeMode) || "light";
    setThemeMode(next);
    try {
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    applyThemeMode(next);
    window.dispatchEvent(new Event(THEME_MODE_CHANGE_EVENT));
  };

  return (
    <SettingsSection title="外观设置" description="自定义应用的视觉风格">
      <SettingsCard>
        <SettingsSegmentedControl
          label="主题模式"
          description="选择应用的配色方案"
          value={themeMode}
          onValueChange={handleThemeChange}
          options={THEME_OPTIONS}
        />
        <SettingsRow label="界面缩放" description={zoomHint} />
      </SettingsCard>
      <p className={cn("text-xs text-muted-foreground")}>
        提示：主题模式会保存到本地浏览器（仅影响当前设备）。
      </p>
    </SettingsSection>
  );
}
