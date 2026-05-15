import { AlignLeft, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, cn, Input, Label, SettingsCard, SettingsSection, Textarea } from "ui";
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
      notifySuccess("已保存", "系统提示词已更新");
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
      <SettingsSection title="账户信息" description="管理你的账号显示信息（本地展示）。">
        <SettingsCard divided={false} className="p-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground">
              {username?.charAt(0).toUpperCase() || "U"}
            </div>
            <div>
              <p className="text-base leading-tight font-bold">{username || "未设置用户名"}</p>
              <p className="text-sm text-muted-foreground">{email}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>用户名</Label>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>邮箱</Label>
              <Input value={email} disabled />
              <p className="text-xs text-muted-foreground">邮箱暂不支持修改</p>
            </div>
            <div>
              <Button type="button">保存修改</Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="自定义指令"
        description="对所有对话与 Agent 会话生效，用于设置你的个人偏好与回答风格。"
      >
        <SettingsCard divided={false} className="p-4">
          <div className="mb-3 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <AlignLeft size={18} className="text-muted-foreground" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-bold">自定义指令</p>
                  {savedPrompt && !editing && (
                    <Badge variant="secondary">{savedPrompt.length} 字符</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  自定义 AI 的回答方式、语言与行为偏好。
                </p>
              </div>
            </div>
            {!editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil size={13} />
                编辑
              </Button>
            )}
          </div>

          <Textarea
            placeholder="例如：你是一个专业的代码助手，请用中文回答所有问题..."
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
                取消
              </Button>
              <Button onClick={() => void handleSavePrompt()} disabled={savingPrompt}>
                {savingPrompt ? "保存中..." : "保存"}
              </Button>
            </div>
          ) : (
            !savedPrompt && (
              <p className="mt-2 text-sm italic text-muted-foreground">
                暂未设置，点击右上角「编辑」添加。
              </p>
            )
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
