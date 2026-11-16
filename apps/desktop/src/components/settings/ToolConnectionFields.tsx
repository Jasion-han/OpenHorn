import { useEffect, useState } from "react";
import { toolBaseUrl } from "shared/tool-connection";
import { Button, Input, Label } from "ui";
import { getDeepSeekLabel as label } from "../../lib/i18n/agent";
import { emptyToolConnection, type ToolConnectionDraft } from "./toolConnectionDraft";

/** A chat channel's protocol is not evidence that it exposes the Search API. */
export function ToolConnectionFields({
  value,
  disabled,
  onChange,
}: {
  value: ToolConnectionDraft;
  disabled: boolean;
  onChange(value: ToolConnectionDraft): void;
}) {
  const [addressOpen, setAddressOpen] = useState(false);
  useEffect(() => {
    if (value.source === "manual" && value.baseUrl !== toolBaseUrl("deepseek"))
      setAddressOpen(true);
  }, [value.source, value.baseUrl]);
  if (value.source === "channel")
    return (
      <div className="space-y-2">
        <p className="text-sm">{label("legacyChannel")}</p>
        <p className="text-xs text-muted-foreground">{label("legacyChannelHint")}</p>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange({ ...emptyToolConnection })}
        >
          {label("manualKey")}
        </Button>
      </div>
    );
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="deepseek-tools-key">{label("toolsKey")}</Label>
        <Input
          id="deepseek-tools-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={disabled}
          value={value.key}
          onChange={(event) => onChange({ ...value, key: event.target.value })}
        />
      </div>
      <details
        open={addressOpen}
        onToggle={(event) => setAddressOpen(event.currentTarget.open)}
        className="text-sm"
      >
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {label("customAddress")}
        </summary>
        <div className="mt-3 space-y-2">
          <Label htmlFor="tool-base-url">{label("baseUrl")}</Label>
          <Input
            id="tool-base-url"
            type="url"
            maxLength={2048}
            disabled={disabled}
            value={value.baseUrl}
            onChange={(event) => onChange({ ...value, baseUrl: event.target.value, key: "" })}
          />
          <p className="text-xs text-muted-foreground">{label("baseUrlHint")}</p>
        </div>
      </details>
    </div>
  );
}
