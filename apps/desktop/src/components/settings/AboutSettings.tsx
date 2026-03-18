import { SettingsCard, SettingsRow, SettingsSection } from "ui";

export function AboutSettings() {
  return (
    <SettingsSection title="关于" description="OpenHorn 桌面端信息。">
      <SettingsCard>
        <SettingsRow label="应用" description="OpenHorn Desktop" />
        <SettingsRow
          label="说明"
          description="Tauri + React + Tailwind + shadcn/ui 风格（Proma 对齐）。"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
