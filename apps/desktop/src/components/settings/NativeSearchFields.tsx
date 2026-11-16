import {
  NATIVE_SEARCH_BASE_URL,
  NATIVE_SEARCH_CONFIG,
  NATIVE_SEARCH_MODEL,
  type NativeSearchChannelOption,
  parseNativeSearchConfig,
} from "shared/deepseek-native-search";
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "ui";
import { getSearchSettingsLabel as label } from "../../lib/i18n/agent";

export type NativeSearchDraft = { source: "manual" | "channel"; key: string; channelId: string };
export const emptyNativeSearchDraft: NativeSearchDraft = {
  source: "manual",
  key: "",
  channelId: "",
};
export const sameNativeSearchDraft = (a: NativeSearchDraft, b: NativeSearchDraft) =>
  a.source === b.source && a.key === b.key && a.channelId === b.channelId;
export const readyNativeSearchDraft = (value: NativeSearchDraft) =>
  value.source === "manual" ? Boolean(value.key.trim()) : Boolean(value.channelId);
export function loadNativeSearchDraft(settings: Record<string, string>): NativeSearchDraft {
  if (!settings[NATIVE_SEARCH_CONFIG]) return { ...emptyNativeSearchDraft };
  const config = parseNativeSearchConfig(settings[NATIVE_SEARCH_CONFIG]);
  return config.source === "manual"
    ? { source: "manual", key: config.apiKey, channelId: "" }
    : { source: "channel", key: "", channelId: config.channelId };
}
export function serializeNativeSearchDraft(value: NativeSearchDraft): string {
  return JSON.stringify(
    parseNativeSearchConfig(
      JSON.stringify(
        value.source === "manual"
          ? { source: "manual", apiKey: value.key.trim() }
          : { source: "channel", channelId: value.channelId },
      ),
    ),
  );
}

export function NativeSearchFields({
  value,
  channels,
  disabled,
  onChange,
}: {
  value: NativeSearchDraft;
  channels: NativeSearchChannelOption[];
  disabled: boolean;
  onChange(value: NativeSearchDraft): void;
}) {
  const missing =
    value.source === "channel" &&
    !channels.some((channel) => channel.channelId === value.channelId);
  return (
    <div className="space-y-3">
      {(channels.length > 0 || value.source === "channel") && (
        <div className="space-y-2">
          <Label htmlFor="native-search-credentials">{label("nativeCredentials")}</Label>
          <Select
            value={value.source === "manual" ? "manual" : `channel:${value.channelId}`}
            disabled={disabled}
            onValueChange={(selected) =>
              onChange(
                selected === "manual"
                  ? { ...emptyNativeSearchDraft }
                  : { source: "channel", channelId: selected.slice("channel:".length), key: "" },
              )
            }
          >
            <SelectTrigger id="native-search-credentials" aria-label={label("nativeCredentials")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">{label("nativeManual")}</SelectItem>
              {missing && (
                <SelectItem value={`channel:${value.channelId}`} disabled>
                  {label("nativeChannelUnavailable")}
                </SelectItem>
              )}
              {channels.map((channel) => (
                <SelectItem key={channel.channelId} value={`channel:${channel.channelId}`}>
                  {channel.name} · {channel.model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {value.source === "manual" ? (
        <div className="space-y-2">
          <Label htmlFor="native-search-key">{label("nativeKey")}</Label>
          <Input
            id="native-search-key"
            type="password"
            value={value.key}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, key: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{label("nativeManualHint")}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{label("nativeChannelHint")}</p>
      )}
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {label("nativeModel")} {NATIVE_SEARCH_MODEL}
        </p>
        <p>
          {label("nativeEndpoint")} {NATIVE_SEARCH_BASE_URL}
        </p>
      </div>
    </div>
  );
}
