import { AlignLeft, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, cn, Input, Label, SettingsCard, SettingsSection, Textarea } from "ui";
import { formatGeneralSettingsLabel, getGeneralSettingsLabel } from "../../lib/i18n/agent";
import { notifySuccess } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useAuthStore } from "../../stores/authStore";

const api = createServerApi();
const SYSTEM_PROMPT_KEY = "chat.systemPrompt";

export function GeneralSettings() {
  const user = useAuthStore((state) => state.user);
  const [username, setUsername] = useState(user?.username || "");
  const [email] = useState(user?.email || "");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [editing, setEditing] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    api.settings
      .get([SYSTEM_PROMPT_KEY])
      .then(({ settings }) => {
        const value = settings[SYSTEM_PROMPT_KEY] || "";
        setSystemPrompt(value);
        setSavedPrompt(value);
        setEditing(!value);
      })
      .catch(() => {});
  }, []);

  const handleSavePrompt = async () => {
    setSavingPrompt(true);
    try {
      await api.settings.set(SYSTEM_PROMPT_KEY, systemPrompt || null);
      setSavedPrompt(systemPrompt);
      setEditing(false);
      notifySuccess(
        getGeneralSettingsLabel("settings.general.notify.savedTitle"),
        getGeneralSettingsLabel("settings.general.notify.promptSavedBody"),
      );
    } catch {
      // Keep behavior aligned with web for now.
    } finally {
      setSavingPrompt(false);
    }
  };

  const handleCancelEdit = () => {
    setSystemPrompt(savedPrompt);
    setEditing(false);
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title={getGeneralSettingsLabel("settings.general.account.title")}
        description={getGeneralSettingsLabel("settings.general.account.description")}
      >
        <SettingsCard divided={false} className="p-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
              {username?.charAt(0).toUpperCase() || "U"}
            </div>
            <div>
              <p className="text-base leading-tight font-bold">
                {username || getGeneralSettingsLabel("settings.general.account.usernameFallback")}
              </p>
              <p className="text-sm text-muted-foreground">{email}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{getGeneralSettingsLabel("settings.general.account.usernameLabel")}</Label>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{getGeneralSettingsLabel("settings.general.account.emailLabel")}</Label>
              <Input value={email} disabled />
              <p className="text-xs text-muted-foreground">
                {getGeneralSettingsLabel("settings.general.account.emailReadonly")}
              </p>
            </div>
            <div>
              <Button type="button">
                {getGeneralSettingsLabel("settings.general.account.save")}
              </Button>
            </div>
          </div>
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
                <AlignLeft size={18} className="text-muted-foreground" />
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
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil size={13} />
                {getGeneralSettingsLabel("settings.general.instructions.edit")}
              </Button>
            )}
          </div>

          <Textarea
            placeholder={getGeneralSettingsLabel("settings.general.instructions.placeholder")}
            value={editing ? systemPrompt : savedPrompt || ""}
            onChange={(event) => setSystemPrompt(event.target.value)}
            readOnly={!editing}
            className={cn(
              "mt-2 h-[min(460px,50vh)] min-h-[320px] resize-y font-mono text-sm leading-relaxed",
              !editing && "cursor-default bg-muted text-muted-foreground",
            )}
            rows={14}
          />

          {editing ? (
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={handleCancelEdit} disabled={savingPrompt}>
                {getGeneralSettingsLabel("settings.general.instructions.cancel")}
              </Button>
              <Button onClick={() => void handleSavePrompt()} disabled={savingPrompt}>
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
    </div>
  );
}
