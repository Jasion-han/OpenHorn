import { useRef, useState } from "react";
import { JEV_FEATURES } from "shared/decisions";
import type { JevPreferences } from "shared/types";
import { Button, Label, SettingsCard, SettingsSection, Switch } from "ui";
import { useJevStatus } from "../../hooks/useJevStatus";
import { decisionApi } from "../../lib/decisionApi";
import { getJevLabel as label } from "../../lib/i18n/agent";

export function JevSettings() {
  const { status, loading, error, reload, accept, isCurrent } = useJevStatus();
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(false);
  const writing = useRef(false);
  const save = async (preferences: JevPreferences) => {
    if (!status || writing.current) return;
    writing.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      const result = await decisionApi.configure(preferences);
      if (isCurrent()) accept(result);
    } catch {
      if (isCurrent()) setSaveError(true);
    } finally {
      writing.current = false;
      if (isCurrent()) setSaving(false);
    }
  };
  return (
    <SettingsSection title={label("jev.title")} description={label("jev.description")}>
      <SettingsCard divided={false} className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="jev-enabled">{label("jev.enabled")}</Label>
            <p className="text-xs text-muted-foreground">
              {loading && !status
                ? label("jev.loading")
                : status?.configured
                  ? label("jev.configured")
                  : label("jev.notConfigured")}
            </p>
          </div>
          <Switch
            id="jev-enabled"
            checked={status?.enabled ?? false}
            disabled={!status?.configured || saving || loading}
            onCheckedChange={(enabled) =>
              status && void save({ enabled, features: status.features })
            }
          />
        </div>
        {(error || saveError) && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 text-sm text-destructive"
          >
            <span>{label(saveError ? "jev.saveError" : "jev.loadError")}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={saving || loading}
              onClick={() => void reload()}
            >
              {label("jev.retry")}
            </Button>
          </div>
        )}
        {status && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {label("jev.cost")
              .replace("{spent}", status.spentUsd.toFixed(6))
              .replace("{reserved}", status.reservedUsd.toFixed(6))
              .replace("{limit}", status.dailyLimitUsd.toFixed(2))}
          </p>
        )}
        {status?.shadow && status.features.routeShadow && (
          <p className="text-xs text-muted-foreground">
            {label("jev.shadowStats")
              .replace("{compared}", String(status.shadow.compared))
              .replace("{different}", String(status.shadow.disagreements))}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || loading}
          onClick={() => void reload()}
        >
          {label("jev.refreshUsage")}
        </Button>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {label("jev.features")}
          </summary>
          <div className="mt-3 space-y-3">
            {JEV_FEATURES.map((feature) => (
              <div key={feature} className="flex items-center justify-between gap-3">
                <Label htmlFor={`jev-${feature}`} className="font-normal">
                  {label(`jev.feature.${feature}`)}
                </Label>
                <Switch
                  id={`jev-${feature}`}
                  checked={status?.features[feature] ?? false}
                  disabled={!status?.configured || !status.enabled || saving || loading}
                  onCheckedChange={(enabled) =>
                    status &&
                    void save({
                      enabled: status.enabled,
                      features: { ...status.features, [feature]: enabled },
                    })
                  }
                />
              </div>
            ))}
            <p className="text-xs leading-relaxed text-muted-foreground">{label("jev.fallback")}</p>
          </div>
        </details>
      </SettingsCard>
    </SettingsSection>
  );
}
