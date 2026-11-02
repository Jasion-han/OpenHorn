import { useEffect, useId, useState } from "react";
import { resolveContextPolicy } from "shared/context-policy";
import { Button, Input } from "ui";
import { parseContextWindowDraft } from "../../lib/contextWindowDraft";
import { formatChannelLabel, getChannelLabel } from "../../lib/i18n/agent";

export function ModelContextWindowField({
  modelId,
  protocol,
  contextWindow,
  disabled,
  onSave,
}: {
  modelId: string;
  protocol: string;
  contextWindow?: number | null;
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
  const policy = resolveContextPolicy({ model: modelId, protocol, contextWindow });

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
        <span id={`${inputId}-capacity`} className="text-xs text-muted-foreground">
          {formatChannelLabel("settings.channel.context.effective", {
            tokens: policy.contextWindow.toLocaleString("en-US"),
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
