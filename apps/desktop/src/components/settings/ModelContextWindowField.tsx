import { useEffect, useId, useState } from "react";
import type { ModelContextMetadata } from "shared/types";
import { Button, Input } from "ui";
import { parseContextWindowDraft } from "../../lib/contextWindowDraft";
import { contextWindowPresentation } from "../../lib/contextWindowPresentation";
import { formatChannelLabel, getChannelLabel } from "../../lib/i18n/agent";

export function ModelContextWindowField({
  modelId,
  protocol,
  contextWindow,
  contextMetadata,
  disabled,
  onSave,
}: {
  modelId: string;
  protocol: string;
  contextWindow?: number | null;
  contextMetadata?: ModelContextMetadata | null;
  disabled: boolean;
  onSave: (value: number | null) => Promise<void>;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(contextWindow?.toString() ?? "");
  useEffect(() => {
    setDraft(contextWindow?.toString() ?? "");
  }, [contextWindow]);
  const parsed = parseContextWindowDraft(draft);
  const changed = parsed.valid && parsed.value !== (contextWindow ?? null);
  const presentation = contextWindowPresentation({
    model: modelId,
    protocol,
    contextWindow,
    contextMetadata,
  });
  const tokens = presentation.contextWindow.toLocaleString("en-US");
  const sourceLabels = {
    configured: "settings.channel.context.source.configured",
    channel: "settings.channel.context.source.channel",
    catalog: "settings.channel.context.source.catalog",
    runtime: "settings.channel.context.source.runtime",
    model: "settings.channel.context.source.model",
  } as const;
  const details = [
    presentation.checkedAt
      ? formatChannelLabel("settings.channel.context.checkedAt", {
          time: presentation.checkedAt.toLocaleString(),
        })
      : null,
    presentation.inputLimitOnly ? getChannelLabel("settings.channel.context.inputOnly") : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border/40 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && parsed.valid && changed) void onSave(parsed.value);
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor={inputId} className="text-xs text-muted-foreground">
          {getChannelLabel("settings.channel.context.label")}
        </label>
        <Input
          id={inputId}
          type="text"
          inputMode="numeric"
          className="h-8 w-32 text-xs tabular-nums"
          value={draft}
          placeholder={getChannelLabel("settings.channel.context.autoPlaceholder")}
          aria-label={formatChannelLabel("settings.channel.context.inputLabel", { modelId })}
          aria-invalid={!parsed.valid}
          aria-describedby={`${inputId}-capacity${parsed.valid ? "" : ` ${inputId}-error`}`}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-8"
          aria-label={formatChannelLabel("settings.channel.context.saveLabel", { modelId })}
          disabled={disabled || !parsed.valid || !changed}
        >
          {getChannelLabel("settings.channel.context.save")}
        </Button>
        <span
          id={`${inputId}-capacity`}
          className="text-xs text-muted-foreground"
          title={details || undefined}
        >
          {presentation.source === "fallback"
            ? formatChannelLabel("settings.channel.context.unknown", { tokens })
            : formatChannelLabel("settings.channel.context.known", {
                source: getChannelLabel(sourceLabels[presentation.source]),
                tokens,
              })}
        </span>
      </div>
      {!parsed.valid && (
        <p id={`${inputId}-error`} className="text-xs text-destructive" role="alert">
          {getChannelLabel("settings.channel.context.invalid")}
        </p>
      )}
    </form>
  );
}
