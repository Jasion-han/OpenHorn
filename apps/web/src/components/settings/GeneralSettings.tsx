'use client';

import { useState, useEffect } from 'react';
import { AlignLeft, Pencil } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import { notifySuccess, notifyError } from '../../lib/notify';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { Label } from '../ui/label';
import { cn } from '@/lib/utils';
import { SettingsCard, SettingsSection } from 'ui';

const SYSTEM_PROMPT_KEY = 'chat.systemPrompt';

export function GeneralSettings() {
  const { user } = useAuthStore();
  const [username, setUsername] = useState(user?.username || '');
  const [email] = useState(user?.email || '');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [editing, setEditing] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  useEffect(() => {
    api.settings.get([SYSTEM_PROMPT_KEY]).then(({ settings }) => {
      const val = settings[SYSTEM_PROMPT_KEY] || '';
      setSystemPrompt(val);
      setSavedPrompt(val);
      setEditing(!val);
    }).catch(() => {});
  }, []);

  const handleSavePrompt = async () => {
    setSavingPrompt(true);
    try {
      await api.settings.set(SYSTEM_PROMPT_KEY, systemPrompt || null);
      setSavedPrompt(systemPrompt);
      setEditing(false);
      notifySuccess('已保存', '系统提示词已更新');
    } catch {
      notifyError('保存失败', '无法保存系统提示词');
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
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-xl">
              {username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div>
              <p className="font-bold text-base leading-tight">{username || '未设置用户名'}</p>
              <p className="text-sm text-muted-foreground">{email}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>用户名</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>邮箱</Label>
              <Input value={email} disabled />
              <p className="text-xs text-muted-foreground">邮箱暂不支持修改</p>
            </div>
            <div>
              <Button>保存修改</Button>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="全局系统提示词" description="对所有对话与 Agent 会话生效，优先级低于对话级提示词。">
        <SettingsCard divided={false} className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                <AlignLeft size={18} className="text-muted-foreground" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-bold">全局系统提示词</p>
                  {savedPrompt && !editing && (
                    <Badge variant="secondary">{savedPrompt.length} 字符</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  用于约束模型回答风格、语言与偏好。
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
            value={editing ? systemPrompt : (savedPrompt || '')}
            onChange={(e) => setSystemPrompt(e.target.value)}
            readOnly={!editing}
            className={cn(
              'mt-2 min-h-[320px] h-[min(460px,50vh)] resize-y font-mono text-sm leading-relaxed',
              !editing && 'cursor-default bg-muted text-muted-foreground'
            )}
            rows={14}
          />

          {editing ? (
            <div className="flex justify-end gap-2 mt-3">
              <Button variant="ghost" onClick={handleCancelEdit} disabled={savingPrompt}>取消</Button>
              <Button onClick={handleSavePrompt} disabled={savingPrompt}>
                {savingPrompt ? '保存中...' : '保存'}
              </Button>
            </div>
          ) : (
            !savedPrompt && (
              <p className="text-sm text-muted-foreground italic mt-2">暂未设置，点击右上角「编辑」添加。</p>
            )
          )}
        </SettingsCard>
      </SettingsSection>

    </div>
  );
}
