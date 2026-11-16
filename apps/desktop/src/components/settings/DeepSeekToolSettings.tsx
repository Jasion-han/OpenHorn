import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeSearchChannelOption } from "shared/deepseek-native-search";
import { DEEPSEEK_SEARCH_CONNECTION } from "shared/deepseek-search";
import { OPENROUTER_SEARCH_MODEL, type OpenRouterSearchModel } from "shared/openrouter-search";
import type { SearchEngine, SearchSettingsStatus } from "shared/types";
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
} from "ui";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { getSearchSettingsLabel as label, type SearchSettingsLabelKey } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import { useAuthStore } from "../../stores/authStore";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { availableSearchProviders } from "./availableSearchProviders";
import {
  emptyNativeSearchDraft,
  loadNativeSearchDraft,
  type NativeSearchDraft,
  NativeSearchFields,
  readyNativeSearchDraft,
  sameNativeSearchDraft,
  serializeNativeSearchDraft,
} from "./NativeSearchFields";
import {
  loadOpenRouterSearchKey,
  loadOpenRouterSearchModel,
  OpenRouterSearchFields,
  serializeOpenRouterSearchKey,
} from "./OpenRouterSearchFields";
import { ToolConnectionFields } from "./ToolConnectionFields";
import {
  emptyToolConnection,
  isToolDraftReady,
  loadToolDraft,
  sameToolDraft,
  serializeToolDraft,
  type ToolConnectionDraft,
} from "./toolConnectionDraft";

const TAVILY_KEY = "liveSearch.tavilyApiKey";
const UPDATED = "openhorn:agent-settings-updated";
const engines: SearchEngine[] = [
  "tavily",
  "deepseek-native",
  "openrouter",
  "deepseek",
  "duckduckgo",
];
export function DeepSeekToolSettings() {
  const userId = useAuthStore((state) => state.user?.id ?? "");
  return <SearchSettingsSession key={`${getDesktopBackendBase()}:${userId}`} />;
}
function SearchSettingsSession() {
  const api = useRef(createServerApi()).current;
  const [draft, setDraft] = useState<ToolConnectionDraft>({ ...emptyToolConnection });
  const [saved, setSaved] = useState<ToolConnectionDraft>({ ...emptyToolConnection });
  const [nativeDraft, setNativeDraft] = useState<NativeSearchDraft>({ ...emptyNativeSearchDraft });
  const [nativeSaved, setNativeSaved] = useState<NativeSearchDraft>({ ...emptyNativeSearchDraft });
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeChannels, setNativeChannels] = useState<NativeSearchChannelOption[]>([]);
  const [routerKey, setRouterKey] = useState("");
  const [routerModel, setRouterModel] = useState<OpenRouterSearchModel>(OPENROUTER_SEARCH_MODEL);
  const [savedRouterKey, setSavedRouterKey] = useState("");
  const [routerAvailable, setRouterAvailable] = useState(false);
  const [tavily, setTavily] = useState("");
  const [savedTavily, setSavedTavily] = useState("");
  const [provider, setProvider] = useState<SearchEngine>("tavily");
  const [configuringSources, setConfiguringSources] = useState(false);
  const [status, setStatus] = useState<SearchSettingsStatus | null>(null);
  const [busy, setBusy] = useState<"save" | "verify" | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<SearchSettingsLabelKey | null>(null);
  const state = useRef({
    live: false,
    request: 0,
    revision: 0,
    busy: false,
    loaded: false,
    draft: { ...emptyToolConnection },
    saved: { ...emptyToolConnection },
    nativeDraft: { ...emptyNativeSearchDraft },
    nativeSaved: { ...emptyNativeSearchDraft },
    tavily: "",
    savedTavily: "",
    provider: "tavily" as SearchEngine,
    sourceEdited: false,
    activationRevision: null as string | null,
    nativeAvailable: false,
    routerKey: "",
    savedRouterKey: "",
    routerAvailable: false,
  });
  const reload = useCallback(async () => {
    const current = state.current;
    if (current.busy) return;
    const token = ++current.request,
      revision = current.revision;
    setLoading(true);
    try {
      const {
        settings,
        status: nextStatus,
        nativeChannels: availableNativeChannels,
        nativeSearchAvailable,
        openRouterSearchAvailable,
      } = await api.settings.searchConfiguration();
      if (!current.live || token !== current.request) return;
      if (nativeSearchAvailable !== true) {
        current.loaded = false;
        current.nativeAvailable = false;
        setNativeAvailable(false);
        setStatus(null);
        setMessage("nativeUnavailable");
        return;
      }
      if (
        ![...engines, "none"].includes(nextStatus.effectiveProvider) ||
        !Array.isArray(nextStatus.pendingProviders) ||
        typeof nextStatus.revision !== "string"
      )
        throw new Error("search_status_unavailable");
      const nextNative = loadNativeSearchDraft(settings);
      const nextRouterKey = loadOpenRouterSearchKey(settings);
      current.routerAvailable = openRouterSearchAvailable === true;
      setRouterAvailable(current.routerAvailable);
      setNativeChannels(availableNativeChannels ?? []);
      current.nativeAvailable = nativeSearchAvailable === true;
      setNativeAvailable(current.nativeAvailable);
      const next = loadToolDraft(settings),
        nextTavily = settings[TAVILY_KEY] ?? "";
      if (current.revision === revision) {
        setRouterModel(loadOpenRouterSearchModel(settings));
        if (current.routerKey === current.savedRouterKey) {
          current.routerKey = nextRouterKey;
          setRouterKey(nextRouterKey);
        }
        current.savedRouterKey = nextRouterKey;
        setSavedRouterKey(nextRouterKey);
        if (sameNativeSearchDraft(current.nativeDraft, current.nativeSaved)) {
          current.nativeDraft = nextNative;
          setNativeDraft(nextNative);
        }
        current.nativeSaved = nextNative;
        setNativeSaved(nextNative);
        if (sameToolDraft(current.draft, current.saved)) {
          current.draft = next;
          setDraft(next);
        }
        if (current.tavily === current.savedTavily) {
          current.tavily = nextTavily;
          setTavily(nextTavily);
        }
        current.saved = next;
        setSaved(next);
        current.savedTavily = nextTavily;
        setSavedTavily(nextTavily);
        // A late refresh may update the current-source display without updating the form.
        // Only a snapshot applied to the saved form baseline can authorize activation.
        current.activationRevision = nextStatus.revision;
        if (!current.sourceEdited) {
          current.provider =
            nextStatus.effectiveProvider === "none"
              ? nextStatus.selectedProvider !== "auto"
                ? nextStatus.selectedProvider
                : "tavily"
              : nextStatus.effectiveProvider;
          setProvider(current.provider);
        }
      }
      current.loaded = true;
      setStatus(nextStatus);
      setMessage((previous) =>
        previous === "loadError" || previous === "nativeUnavailable" ? null : previous,
      );
    } catch {
      if (current.live && token === current.request) {
        current.loaded = false;
        setMessage("loadError");
      }
    } finally {
      if (current.live && token === current.request) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    const current = state.current;
    current.live = true;
    void reload();
    const onUp = () => void reload();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    window.addEventListener(UPDATED, onUp);
    return () => {
      current.live = false;
      current.request++;
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
      window.removeEventListener(UPDATED, onUp);
    };
  }, [reload]);
  const change = (next: ToolConnectionDraft) => {
    if (state.current.busy) return;
    state.current.revision++;
    state.current.draft = next;
    setDraft(next);
    setMessage(null);
  };
  const dirty =
    provider === "openrouter"
      ? routerKey.trim() !== savedRouterKey
      : provider === "deepseek-native"
        ? !sameNativeSearchDraft(nativeDraft, nativeSaved)
        : provider === "deepseek"
          ? !sameToolDraft(draft, saved)
          : provider === "tavily"
            ? tavily.trim() !== savedTavily
            : false;
  const ready =
    provider === "openrouter"
      ? routerAvailable && Boolean(routerKey.trim()) && !/\s/.test(routerKey.trim())
      : provider === "deepseek-native"
        ? nativeAvailable && readyNativeSearchDraft(nativeDraft)
        : provider !== "deepseek" || isToolDraftReady(draft);
  const changeNative = (next: NativeSearchDraft) => {
    if (state.current.busy) return;
    state.current.revision++;
    state.current.nativeDraft = next;
    setNativeDraft(next);
    setMessage(null);
  };
  const changeRouter = (value: string) => {
    if (state.current.busy) return;
    state.current.revision++;
    state.current.routerKey = value;
    setRouterKey(value);
    setMessage(null);
  };
  const save = async () => {
    const current = state.current;
    if (!current.loaded || current.busy || !dirty || !ready) return;
    let value: string;
    try {
      value =
        provider === "openrouter"
          ? serializeOpenRouterSearchKey(routerKey, routerModel)
          : provider === "deepseek-native"
            ? serializeNativeSearchDraft(nativeDraft)
            : provider === "deepseek"
              ? serializeToolDraft(draft)
              : tavily.trim();
    } catch {
      setMessage(
        provider === "openrouter"
          ? "openRouterConnectionError"
          : provider === "deepseek-native"
            ? "nativeConnectionError"
            : "connectionError",
      );
      return;
    }
    const selected = provider,
      next = { ...draft, key: draft.key.trim() };
    const nextNative = { ...nativeDraft, key: nativeDraft.key.trim() };
    const nextRouterKey = routerKey.trim();
    current.busy = true;
    current.request++;
    setBusy("save");
    setMessage(null);
    try {
      if (selected === "openrouter") {
        if (!current.routerAvailable) return;
        await api.settings.setOpenRouterSearchConnection(value);
      } else if (selected === "deepseek-native") {
        if (!current.nativeAvailable) return;
        await api.settings.setNativeSearchConnection(value || null);
      } else
        await api.settings.set(
          selected === "deepseek" ? DEEPSEEK_SEARCH_CONNECTION : TAVILY_KEY,
          value || null,
        );
      if (selected === "openrouter") {
        current.routerKey = nextRouterKey;
        current.savedRouterKey = nextRouterKey;
      } else if (selected === "deepseek-native") {
        current.nativeDraft = nextNative;
        current.nativeSaved = nextNative;
      } else if (selected === "deepseek") {
        current.draft = next;
        current.saved = next;
      } else {
        current.tavily = value;
        current.savedTavily = value;
      }
      if (!current.live) return;
      if (selected === "openrouter") {
        setRouterKey(nextRouterKey);
        setSavedRouterKey(nextRouterKey);
      } else if (selected === "deepseek-native") {
        setNativeDraft(nextNative);
        setNativeSaved(nextNative);
      } else if (selected === "deepseek") {
        setDraft(next);
        setSaved(next);
      } else {
        setTavily(value);
        setSavedTavily(value);
      }
      setMessage("saved");
    } catch {
      if (current.live) setMessage("saveError");
    } finally {
      current.busy = false;
      if (current.live) setBusy(null);
      window.dispatchEvent(new Event(UPDATED));
    }
  };
  const activate = async () => {
    const current = state.current;
    if (
      !current.loaded ||
      current.busy ||
      loading ||
      dirty ||
      !ready ||
      !status ||
      !current.activationRevision
    )
      return;
    current.busy = true;
    current.request++;
    setBusy("verify");
    setMessage(null);
    try {
      const result = await api.settings.verifyAndActivateSearch({
        provider,
        revision: current.activationRevision,
      });
      if (!current.live) return;
      if (result.success) {
        setStatus(result.status);
        current.sourceEdited = false;
        setMessage("activated");
      } else setMessage(result.errorCode);
    } catch {
      if (current.live) setMessage("search_request_failed");
    } finally {
      current.busy = false;
      if (current.live) setBusy(null);
      window.dispatchEvent(new Event(UPDATED));
    }
  };
  const unavailable = !state.current.loaded || Boolean(busy);
  const available = availableSearchProviders(
    status?.availableProviders,
    status?.effectiveProvider ?? "none",
    status?.configuredProviders ?? [
      ...(savedTavily ? ["tavily" as const] : []),
      ...(nativeSaved.key || nativeSaved.channelId ? ["deepseek-native" as const] : []),
      ...(savedRouterKey ? ["openrouter" as const] : []),
      ...(saved.key || saved.channelId ? ["deepseek" as const] : []),
    ],
  );
  const connectionLabel = (engine: SearchEngine) =>
    label(engine) +
    (!configuringSources && !status?.availableProviders?.includes(engine)
      ? label("needsVerificationSuffix")
      : "");
  const visibleEngines = configuringSources ? engines : available;
  const showFields = configuringSources || available.includes(provider);
  const alreadyEnabled =
    !configuringSources &&
    !dirty &&
    status?.effectiveProvider === provider &&
    status.verification === "verified" &&
    (provider === "duckduckgo" || !status.pendingProviders.includes(provider));
  const success = message === "saved" || message === "activated";
  return (
    <SettingsSection title={label("title")} description={label("description")}>
      <SettingsCard divided={false} className="space-y-4 p-4">
        <div
          className="rounded-xl border border-border/50 bg-background/60 p-3"
          aria-live="polite"
          data-testid="active-search-source"
        >
          <p className="text-sm font-medium">
            {label("currentSource")}{" "}
            {status ? label(status.effectiveProvider) : label(loading ? "loading" : "unknown")}
          </p>
          {status && (
            <p className="mt-1 text-xs text-muted-foreground">{label(status.verification)}</p>
          )}
        </div>
        {status?.nativeConnection && (
          <p className="text-xs text-muted-foreground">
            {label("nativeUsing")} {status.nativeConnection.channelName ?? label("nativeManual")} ·{" "}
            {status.nativeConnection.model}
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="search-source">
            {label(configuringSources ? "configureSource" : "availableSource")}
          </Label>
          <Select
            value={provider}
            disabled={unavailable || (!configuringSources && available.length === 0)}
            onValueChange={(next) => {
              state.current.revision++;
              state.current.sourceEdited = true;
              state.current.provider = next as SearchEngine;
              setProvider(next as SearchEngine);
              setMessage(null);
            }}
          >
            <SelectTrigger id="search-source" aria-label={label("source")}>
              <SelectValue>
                {!configuringSources && !available.includes(provider)
                  ? label(available.length ? "selectVerifiedSource" : "noVerifiedSources")
                  : connectionLabel(provider)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {visibleEngines
                .filter(
                  (engine) =>
                    (engine !== "openrouter" || routerAvailable || provider === "openrouter") &&
                    (engine !== "deepseek-native" ||
                      nativeAvailable ||
                      provider === "deepseek-native"),
                )
                .map((engine) => (
                  <SelectItem
                    key={engine}
                    value={engine}
                    disabled={
                      (engine === "deepseek-native" && !nativeAvailable) ||
                      (engine === "openrouter" && !routerAvailable)
                    }
                  >
                    {connectionLabel(engine)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={unavailable}
            onClick={() => {
              const nextMode = !configuringSources;
              setConfiguringSources(nextMode);
              if (!nextMode && !available.includes(state.current.provider) && available.length) {
                const next = available.includes(status?.effectiveProvider as SearchEngine)
                  ? (status?.effectiveProvider as SearchEngine)
                  : available[0];
                state.current.revision++;
                state.current.provider = next;
                state.current.sourceEdited = true;
                setProvider(next);
                setMessage(null);
              }
            }}
          >
            {label(configuringSources ? "showAvailableSources" : "configureSources")}
          </Button>
        </div>
        {!showFields ? (
          <p className="text-xs text-muted-foreground">
            {label(available.length ? "selectVerifiedSourceHint" : "noVerifiedSourcesHint")}
          </p>
        ) : provider === "openrouter" ? (
          routerAvailable ? (
            <>
              <p className="text-xs text-muted-foreground">{label("openRouterHint")}</p>
              <OpenRouterSearchFields
                value={routerKey}
                model={routerModel}
                disabled={unavailable}
                onChange={changeRouter}
              />
            </>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {label("openRouterUnavailable")}
            </p>
          )
        ) : provider === "deepseek-native" ? (
          nativeAvailable ? (
            <>
              <p className="text-xs text-muted-foreground">{label("nativeHint")}</p>
              <NativeSearchFields
                value={nativeDraft}
                channels={nativeChannels}
                disabled={unavailable}
                onChange={changeNative}
              />
            </>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {label("nativeUnavailable")}
            </p>
          )
        ) : provider === "deepseek" ? (
          <>
            <p className="text-xs text-muted-foreground">{label("deepseekHint")}</p>
            <ToolConnectionFields value={draft} disabled={unavailable} onChange={change} />
          </>
        ) : provider === "tavily" ? (
          <div className="space-y-2">
            <Label htmlFor="tavily-api-key">{label("tavilyKey")}</Label>
            <Input
              id="tavily-api-key"
              type="password"
              autoComplete="off"
              disabled={unavailable}
              value={tavily}
              onChange={(event) => {
                state.current.revision++;
                state.current.tavily = event.target.value;
                setTavily(event.target.value);
                setMessage(null);
              }}
            />
            <p className="text-xs text-muted-foreground">{label("tavilyHint")}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{label("duckduckgoHint")}</p>
        )}
        {showFields && provider !== "duckduckgo" && (
          <p className="text-xs text-muted-foreground">
            {label(
              provider === "openrouter"
                ? "openRouterVerifyHint"
                : provider === "deepseek-native"
                  ? "nativeVerifyHint"
                  : "verifyHint",
            )}
          </p>
        )}
        {showFields && provider !== "duckduckgo" && status?.pendingProviders.includes(provider) && (
          <p className="text-xs text-muted-foreground">{label("pending")}</p>
        )}
        {message &&
          (success ? (
            <output className="block text-sm text-muted-foreground">{label(message)}</output>
          ) : (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{label(message)}</p>
              {(message === "loadError" || message === "nativeUnavailable") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading || Boolean(busy)}
                  onClick={() => void reload()}
                >
                  {label("retry")}
                </Button>
              )}
            </div>
          ))}
        {showFields && (
          <div className="flex flex-wrap justify-end gap-2">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={unavailable}
                onClick={() => {
                  if (provider === "openrouter") changeRouter(state.current.savedRouterKey);
                  else if (provider === "deepseek-native") changeNative(state.current.nativeSaved);
                  else if (provider === "deepseek") change(state.current.saved);
                  else {
                    state.current.revision++;
                    state.current.tavily = state.current.savedTavily;
                    setTavily(state.current.savedTavily);
                    setMessage(null);
                  }
                }}
              >
                {label("cancel")}
              </Button>
            )}
            {provider !== "duckduckgo" && (
              <Button
                type="button"
                variant="outline"
                disabled={unavailable || !dirty || !ready}
                onClick={() => void save()}
              >
                {label(busy === "save" ? "saving" : "save")}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={unavailable || loading || dirty || !ready || alreadyEnabled}
              onClick={() => void activate()}
            >
              {label(
                alreadyEnabled
                  ? "alreadyEnabled"
                  : busy === "verify"
                    ? "verifying"
                    : provider === "duckduckgo"
                      ? "enable"
                      : "verifyEnable",
              )}
            </Button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
