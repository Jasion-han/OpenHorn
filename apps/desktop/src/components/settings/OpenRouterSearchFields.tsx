import {
  OPENROUTER_SEARCH_BASE_URL,
  OPENROUTER_SEARCH_CONFIG,
  OPENROUTER_SEARCH_MODEL,
  type OpenRouterSearchModel,
  parseOpenRouterSearchConfig,
} from "shared/openrouter-search";
import { Input, Label } from "ui";
import { getSearchSettingsLabel as label } from "../../lib/i18n/agent";

export function loadOpenRouterSearchKey(settings: Record<string, string>): string {
  return settings[OPENROUTER_SEARCH_CONFIG]
    ? parseOpenRouterSearchConfig(settings[OPENROUTER_SEARCH_CONFIG]).apiKey
    : "";
}
export function loadOpenRouterSearchModel(settings: Record<string, string>): OpenRouterSearchModel {
  return settings[OPENROUTER_SEARCH_CONFIG]
    ? parseOpenRouterSearchConfig(settings[OPENROUTER_SEARCH_CONFIG]).model
    : OPENROUTER_SEARCH_MODEL;
}
export const serializeOpenRouterSearchKey = (
  key: string,
  model: OpenRouterSearchModel = OPENROUTER_SEARCH_MODEL,
) => JSON.stringify(parseOpenRouterSearchConfig(JSON.stringify({ apiKey: key.trim(), model })));

export function OpenRouterSearchFields({
  value,
  model,
  disabled,
  onChange,
}: {
  value: string;
  model: OpenRouterSearchModel;
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="openrouter-search-key">{label("openRouterKey")}</Label>
        <Input
          id="openrouter-search-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{label("openRouterKeyHint")}</p>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {label("nativeModel")} {model}
        </p>
        <p>{label("openRouterEngine")}</p>
        <p>
          {label("nativeEndpoint")} {OPENROUTER_SEARCH_BASE_URL}
        </p>
      </div>
    </div>
  );
}
