import { useEffect, useMemo, useState } from "react";
import { cn, SettingsCard, SettingsRow, SettingsSection, SettingsSegmentedControl } from "ui";

import { getAppearanceSettingsLabel } from "../../lib/i18n/agent";
import type { ThemeMode } from "../../lib/theme";
import { readThemeMode, setThemeMode, THEME_MODE_CHANGE_EVENT } from "../../lib/theme";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: getAppearanceSettingsLabel("settings.appearance.theme.light") },
  { value: "dark", label: getAppearanceSettingsLabel("settings.appearance.theme.dark") },
  { value: "system", label: getAppearanceSettingsLabel("settings.appearance.theme.system") },
];

function getZoomHint() {
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  return isMac
    ? getAppearanceSettingsLabel("settings.appearance.zoom.hintMac")
    : getAppearanceSettingsLabel("settings.appearance.zoom.hintOther");
}

export function AppearanceSettings() {
  const [themeMode, setMode] = useState<ThemeMode>("light");
  const zoomHint = useMemo(() => getZoomHint(), []);

  useEffect(() => {
    const apply = () => setMode(readThemeMode());
    apply();
    window.addEventListener(THEME_MODE_CHANGE_EVENT, apply);
    return () => window.removeEventListener(THEME_MODE_CHANGE_EVENT, apply);
  }, []);

  const handleThemeChange = (value: string) => {
    const next = value as ThemeMode;
    setMode(next);
    setThemeMode(next);
  };

  return (
    <SettingsSection
      title={getAppearanceSettingsLabel("settings.appearance.title")}
      description={getAppearanceSettingsLabel("settings.appearance.description")}
    >
      <SettingsCard>
        <SettingsSegmentedControl
          label={getAppearanceSettingsLabel("settings.appearance.theme.title")}
          description={getAppearanceSettingsLabel("settings.appearance.theme.description")}
          value={themeMode}
          onValueChange={handleThemeChange}
          options={THEME_OPTIONS}
        />
        <SettingsRow
          label={getAppearanceSettingsLabel("settings.appearance.zoom.title")}
          description={zoomHint}
        />
      </SettingsCard>
      <p className={cn("text-xs text-muted-foreground")}>
        {getAppearanceSettingsLabel("settings.appearance.persistNote")}
      </p>
    </SettingsSection>
  );
}
