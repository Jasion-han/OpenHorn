import { Pencil, ScrollText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  Textarea,
} from "ui";
import { formatGeneralSettingsLabel, getGeneralSettingsLabel } from "../../lib/i18n/agent";
import { notifySuccess } from "../../lib/notify";
import { isDesktopRuntime, pickEditorApp } from "../../lib/tauriBridge";
import { useAuthStore } from "../../stores/authStore";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { editorNameFromAppPath, useExternalEditorStore } from "../../stores/externalEditorStore";
import { useGeneralSettingsStore } from "../../stores/generalSettingsStore";
import { useGenUiStore } from "../../stores/genUiStore";
import { DiscardChangesDialog } from "../workbench/DiscardChangesDialog";

// Radix Select forbids empty-string values, so the non-editor rows use sentinels.
const EDITOR_UNSET = "__unset";
const EDITOR_CUSTOM = "__custom";
const EDITOR_PICK = "__pick";
const EDITOR_DETECTED_PREFIX = "detected:";

export function GeneralSettings() {
  const user = useAuthStore((state) => state.user);
  const username = user?.username ?? "";
  const email = user?.email ?? "";
  const {
    value: systemPrompt,
    savedValue: savedPrompt,
    editing,
    saving: savingPrompt,
    loading: loadingPrompt,
    loaded: promptLoaded,
    error: promptError,
    setValue: setSystemPrompt,
    edit: editPrompt,
    cancel: cancelPrompt,
    load: loadPrompt,
    save: savePrompt,
  } = useGeneralSettingsStore();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editorPreference = useExternalEditorStore((state) => state.preference);
  const detectedEditors = useExternalEditorStore((state) => state.detected);
  const setEditorPreference = useExternalEditorStore((state) => state.setPreference);
  const detectEditors = useExternalEditorStore((state) => state.detect);
  const genUiEnabled = useGenUiStore((state) => state.enabled);
  const setGenUiEnabled = useGenUiStore((state) => state.setEnabled);
  const desktop = isDesktopRuntime();

  useEffect(() => {
    if (desktop) void detectEditors();
  }, [desktop, detectEditors]);

  // A detected preference whose editor is no longer installed reads as unset,
  // matching what the preview panel's open button does with it.
  const editorSelectValue = !editorPreference
    ? EDITOR_UNSET
    : editorPreference.kind === "custom"
      ? EDITOR_CUSTOM
      : detectedEditors.some((editor) => editor.id === editorPreference.id)
        ? `${EDITOR_DETECTED_PREFIX}${editorPreference.id}`
        : EDITOR_UNSET;

  const handleEditorChange = useCallback(
    (value: string) => {
      if (value === EDITOR_UNSET) {
        setEditorPreference(null);
        return;
      }
      if (value === EDITOR_PICK) {
        void pickEditorApp().then((appPath) => {
          if (!appPath) return;
          setEditorPreference({ kind: "custom", name: editorNameFromAppPath(appPath), appPath });
        });
        return;
      }
      if (value.startsWith(EDITOR_DETECTED_PREFIX)) {
        setEditorPreference({ kind: "detected", id: value.slice(EDITOR_DETECTED_PREFIX.length) });
      }
    },
    [setEditorPreference],
  );

  // Mount load, repeated after a server reconnect: opened while the server was
  // down, the panel would otherwise keep the empty prompt for good.
  useEffect(() => {
    const load = () => {
      void loadPrompt();
    };
    load();
    window.addEventListener(BACKEND_UP_EVENT, load);
    return () => window.removeEventListener(BACKEND_UP_EVENT, load);
  }, [loadPrompt]);

  const handleSavePrompt = async () => {
    if (await savePrompt()) {
      notifySuccess(
        getGeneralSettingsLabel("settings.general.notify.savedTitle"),
        getGeneralSettingsLabel("settings.general.notify.promptSavedBody"),
      );
    }
  };

  const handleCancelEdit = () => {
    if (systemPrompt !== savedPrompt) setConfirmDiscard(true);
    else cancelPrompt();
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title={getGeneralSettingsLabel("settings.general.account.title")}
        description={getGeneralSettingsLabel("settings.general.account.description")}
      >
        <SettingsCard divided={false} className="p-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xl font-bold text-stone-900">
              {username?.charAt(0).toUpperCase() || "U"}
            </div>
            <div>
              <p className="text-base leading-tight font-bold">
                {username || getGeneralSettingsLabel("settings.general.account.usernameFallback")}
              </p>
              {email && !email.endsWith("@openhorn.local") && (
                <p className="text-sm text-muted-foreground">{email}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="account-username">
                {getGeneralSettingsLabel("settings.general.account.usernameLabel")}
              </Label>
              <Input id="account-username" value={username} readOnly />
            </div>
            {email && !email.endsWith("@openhorn.local") && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="account-email">
                  {getGeneralSettingsLabel("settings.general.account.emailLabel")}
                </Label>
                <Input id="account-email" value={email} readOnly />
                <p className="text-xs text-muted-foreground">
                  {getGeneralSettingsLabel("settings.general.account.emailReadonly")}
                </p>
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={getGeneralSettingsLabel("settings.general.responseFormat.title")}>
        <SettingsCard>
          <SettingsRow
            label={getGeneralSettingsLabel("settings.general.responseFormat.rowLabel")}
            description={getGeneralSettingsLabel("settings.general.responseFormat.description")}
          >
            <Select
              value={genUiEnabled ? "auto" : "text"}
              onValueChange={(value) => setGenUiEnabled(value === "auto")}
            >
              <SelectTrigger
                className="w-40"
                aria-label={getGeneralSettingsLabel("settings.general.responseFormat.title")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {getGeneralSettingsLabel("settings.general.responseFormat.auto")}
                </SelectItem>
                <SelectItem value="text">
                  {getGeneralSettingsLabel("settings.general.responseFormat.textOnly")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={getGeneralSettingsLabel("settings.general.instructions.title")}
        description={getGeneralSettingsLabel("settings.general.instructions.description")}
      >
        <SettingsCard divided={false} className="p-4">
          <div className="mb-3 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <ScrollText size={18} className="text-muted-foreground" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-bold">
                    {getGeneralSettingsLabel("settings.general.instructions.title")}
                  </p>
                  {savedPrompt && !editing && (
                    <Badge variant="secondary">
                      {formatGeneralSettingsLabel("settings.general.instructions.charCount", {
                        count: savedPrompt.length,
                      })}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {getGeneralSettingsLabel("settings.general.instructions.hint")}
                </p>
              </div>
            </div>
            {!editing && (
              <Button
                size="sm"
                variant="ghost"
                onClick={editPrompt}
                disabled={!promptLoaded || savingPrompt}
              >
                <Pencil size={13} />
                {getGeneralSettingsLabel("settings.general.instructions.edit")}
              </Button>
            )}
          </div>

          {loadingPrompt ? (
            <output className="block text-sm text-muted-foreground">
              {getGeneralSettingsLabel("settings.general.instructions.loading")}
            </output>
          ) : null}
          {promptError ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <p>
                {getGeneralSettingsLabel(
                  promptError === "load"
                    ? "settings.general.instructions.loadFailed"
                    : "settings.general.instructions.saveFailed",
                )}
              </p>
              {promptError === "load" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadPrompt()}
                  disabled={loadingPrompt}
                >
                  {getGeneralSettingsLabel("settings.general.instructions.retry")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Label htmlFor="general-system-prompt" className="sr-only">
            {getGeneralSettingsLabel("settings.general.instructions.title")}
          </Label>
          <Textarea
            id="general-system-prompt"
            placeholder={getGeneralSettingsLabel("settings.general.instructions.placeholder")}
            value={editing ? systemPrompt : savedPrompt || ""}
            onChange={(event) => setSystemPrompt(event.target.value)}
            readOnly={!editing}
            disabled={!promptLoaded || savingPrompt}
            className={cn(
              "mt-2 h-[min(460px,50vh)] min-h-[320px] resize-y font-mono text-sm leading-relaxed",
              !editing && "cursor-default bg-muted text-muted-foreground",
            )}
            rows={14}
          />
          {editing && systemPrompt !== savedPrompt ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {getGeneralSettingsLabel("settings.general.instructions.draftHint")}
            </p>
          ) : null}

          {editing ? (
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={handleCancelEdit} disabled={savingPrompt}>
                {getGeneralSettingsLabel("settings.general.instructions.cancel")}
              </Button>
              <Button
                onClick={() => void handleSavePrompt()}
                disabled={savingPrompt || !promptLoaded || systemPrompt === savedPrompt}
              >
                {savingPrompt
                  ? getGeneralSettingsLabel("settings.general.instructions.saving")
                  : getGeneralSettingsLabel("settings.general.instructions.save")}
              </Button>
            </div>
          ) : (
            !savedPrompt && (
              <p className="mt-2 text-sm italic text-muted-foreground">
                {getGeneralSettingsLabel("settings.general.instructions.emptyState")}
              </p>
            )
          )}
        </SettingsCard>
      </SettingsSection>
      <DiscardChangesDialog
        open={confirmDiscard}
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={() => {
          cancelPrompt();
          setConfirmDiscard(false);
        }}
      />

      <SettingsSection
        title={getGeneralSettingsLabel("settings.general.editor.title")}
        description={getGeneralSettingsLabel("settings.general.editor.description")}
      >
        <SettingsCard>
          <SettingsRow
            label={getGeneralSettingsLabel("settings.general.editor.rowLabel")}
            description={
              desktop
                ? getGeneralSettingsLabel("settings.general.editor.rowDescription")
                : getGeneralSettingsLabel("settings.general.editor.desktopOnly")
            }
          >
            <Select
              value={editorSelectValue}
              onValueChange={handleEditorChange}
              disabled={!desktop}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EDITOR_UNSET}>
                  {getGeneralSettingsLabel("settings.general.editor.unset")}
                </SelectItem>
                {detectedEditors.map((editor) => (
                  <SelectItem key={editor.id} value={`${EDITOR_DETECTED_PREFIX}${editor.id}`}>
                    {editor.name}
                  </SelectItem>
                ))}
                {editorPreference?.kind === "custom" ? (
                  <SelectItem value={EDITOR_CUSTOM}>
                    {formatGeneralSettingsLabel("settings.general.editor.customCurrent", {
                      name: editorPreference.name,
                    })}
                  </SelectItem>
                ) : null}
                <SelectSeparator />
                <SelectItem value={EDITOR_PICK}>
                  {getGeneralSettingsLabel("settings.general.editor.custom")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
