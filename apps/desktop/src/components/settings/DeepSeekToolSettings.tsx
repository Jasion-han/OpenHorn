import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsCard,
  SettingsSection,
  Switch,
} from "ui";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { getDeepSeekLabel as label } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import { useAuthStore } from "../../stores/authStore";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";

const keys = ["deepseek.toolsApiKey", "liveSearch.provider", "deepseek.nativeWebEnabled"] as const;
type Draft = { key: string; provider: string; native: boolean };
const empty: Draft = { key: "", provider: "auto", native: false };
const providers = ["auto", "tavily", "deepseek", "duckduckgo"] as const;
const equal = (a: Draft, b: Draft) =>
  a.key === b.key && a.provider === b.provider && a.native === b.native;
const SETTINGS_UPDATED = "openhorn:agent-settings-updated";

export function DeepSeekToolSettings() {
  const userId = useAuthStore((state) => state.user?.id ?? "");
  return <ToolSettingsSession key={`${getDesktopBackendBase()}:${userId}`} />;
}

function ToolSettingsSession() {
  const api = useRef(createServerApi()).current;
  const [draft, setDraft] = useState<Draft>(empty);
  const [saved, setSaved] = useState<Draft>(empty);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<"saved" | "loadError" | "saveError" | "needsKey" | null>(
    null,
  );
  const live = useRef(false);
  const request = useRef(0);
  const state = useRef({ draft: empty, saved: empty, loaded: false, saving: false });
  const change = (next: Draft) => {
    state.current.draft = next;
    setDraft(next);
    setMessage(null);
  };
  const reload = useCallback(async () => {
    if (state.current.saving) return;
    const token = ++request.current;
    setLoading(true);
    try {
      const { settings } = await api.settings.get([...keys]);
      if (!live.current || token !== request.current) return;
      const next: Draft = {
        key: settings[keys[0]] || "",
        provider: providers.includes(settings[keys[1]] as (typeof providers)[number])
          ? settings[keys[1]]
          : "auto",
        native: settings[keys[2]] === "true",
      };
      const current = state.current;
      const merged = {
        key: current.draft.key === current.saved.key ? next.key : current.draft.key,
        provider:
          current.draft.provider === current.saved.provider
            ? next.provider
            : current.draft.provider,
        native: current.draft.native === current.saved.native ? next.native : current.draft.native,
      };
      state.current = { ...current, draft: merged, saved: next, loaded: true };
      setDraft(merged);
      setSaved(next);
      setLoaded(true);
      setMessage((value) => (value === "loadError" ? null : value));
    } catch {
      if (live.current && token === request.current) setMessage("loadError");
    } finally {
      if (live.current && token === request.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    live.current = true;
    void reload();
    const onUp = () => void reload();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    window.addEventListener(SETTINGS_UPDATED, onUp);
    return () => {
      live.current = false;
      request.current++;
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
      window.removeEventListener(SETTINGS_UPDATED, onUp);
    };
  }, [reload]);
  const save = async () => {
    const current = state.current;
    if (!current.loaded || current.saving) return;
    const next = { ...current.draft, key: current.draft.key.trim() };
    if (next.provider === "deepseek" && !next.key) {
      setMessage("needsKey");
      return;
    }
    request.current++;
    current.saving = true;
    setSaving(true);
    setMessage(null);
    try {
      // Persist each field's baseline after its own acknowledgement. A partial
      // write failure keeps the unsaved fields dirty and a retry is idempotent.
      for (const [field, setting, value] of [
        ["key", keys[0], next.key || null],
        ["provider", keys[1], next.provider],
        ["native", keys[2], String(next.native)],
      ] as const) {
        if (!live.current) return;
        if (next[field] === current.saved[field]) continue;
        await api.settings.set(setting, value);
        current.saved = { ...current.saved, [field]: next[field] };
        if (live.current) setSaved(current.saved);
      }
      current.draft = next;
      if (live.current) {
        setDraft(next);
        setMessage("saved");
      }
    } catch {
      if (live.current) setMessage("saveError");
    } finally {
      current.saving = false;
      if (live.current) setSaving(false);
      window.dispatchEvent(new Event(SETTINGS_UPDATED));
    }
  };
  const disabled = !loaded || saving;
  return (
    <SettingsSection title={label("title")} description={label("description")}>
      <SettingsCard divided={false} className="space-y-5 p-4">
        {!loaded && loading && (
          <output className="block text-sm text-muted-foreground">{label("loading")}</output>
        )}
        <div className="space-y-2">
          <Label htmlFor="search-provider">{label("provider")}</Label>
          <Select
            value={draft.provider}
            disabled={disabled}
            onValueChange={(provider) => change({ ...state.current.draft, provider })}
          >
            <SelectTrigger
              id="search-provider"
              className="bg-background"
              aria-describedby="search-provider-hint"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-stone-200 bg-amber-50 text-stone-800">
              {providers.map((provider) => (
                <SelectItem
                  key={provider}
                  value={provider}
                  className="focus:bg-amber-100 focus:text-stone-900 data-[state=checked]:bg-amber-100"
                >
                  {label(`provider.${provider}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id="search-provider-hint" className="text-xs leading-relaxed text-muted-foreground">
            {label("providerHint")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="deepseek-tools-key">{label("toolsKey")}</Label>
          <Input
            id="deepseek-tools-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            disabled={disabled}
            value={draft.key}
            onChange={(event) => change({ ...state.current.draft, key: event.target.value })}
            aria-describedby="deepseek-tools-hint"
          />
          <p id="deepseek-tools-hint" className="text-xs leading-relaxed text-muted-foreground">
            {label("toolsHint")}
          </p>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-xl border border-border/60 bg-background/60 p-3">
          <div className="space-y-1">
            <Label htmlFor="deepseek-native-web">{label("native")}</Label>
            <p id="deepseek-native-hint" className="text-xs leading-relaxed text-muted-foreground">
              {label("nativeHint")}
            </p>
          </div>
          <Switch
            id="deepseek-native-web"
            checked={draft.native}
            disabled={disabled}
            onCheckedChange={(native) => change({ ...state.current.draft, native })}
            aria-describedby="deepseek-native-hint"
            className="data-[state=checked]:bg-amber-200 data-[state=unchecked]:bg-stone-200 focus-visible:ring-amber-600"
          />
        </div>
        {message === "saved" && (
          <output className="block text-sm text-muted-foreground">{label("saved")}</output>
        )}
        {message && message !== "saved" && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 text-sm text-destructive"
          >
            <span>{label(message)}</span>
            {message === "loadError" && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading || saving}
                onClick={() => void reload()}
              >
                {label("retry")}
              </Button>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={disabled || equal(draft, saved)}
            onClick={() => change(state.current.saved)}
          >
            {label("cancel")}
          </Button>
          <Button
            disabled={disabled || equal(draft, saved)}
            onClick={() => void save()}
            className="bg-amber-100 text-stone-800 hover:bg-amber-200 focus-visible:ring-amber-600"
          >
            {label(saving ? "saving" : "save")}
          </Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
