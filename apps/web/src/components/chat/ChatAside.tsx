'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Plus, MoreHorizontal, Trash2, Pin, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import { useChatStore, type Conversation } from '../../stores/chatStore';
import { notifyError, notifySuccess } from '@/lib/notify';
import { api } from '@/lib/api';
import { BACKEND_UP_EVENT } from '@/stores/backendStatusStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/dialogs/ConfirmDialogProvider';

type DateGroup = '今天' | '昨天' | '更早';

function groupByUpdatedAt(items: Conversation[]): Array<{ label: DateGroup; items: Conversation[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const item of items) {
    const ts = item.updatedAt.getTime();
    if (ts >= todayStart) today.push(item);
    else if (ts >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const groups: Array<{ label: DateGroup; items: Conversation[] }> = [];
  if (today.length) groups.push({ label: '今天', items: today });
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday });
  if (earlier.length) groups.push({ label: '更早', items: earlier });
  return groups;
}

function formatNewConversationTitle() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `新会话 ${mm}-${dd} ${hh}:${min}`;
}

function ConvItem({
  conv,
  isActive,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
  pinLabel,
}: {
  conv: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  pinLabel: string;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center justify-between rounded-[10px] px-3 py-[7px] text-sm transition-colors duration-100 titlebar-no-drag text-left border border-transparent',
        isActive
          ? 'bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
          : 'hover:bg-foreground/[0.04] text-foreground/70 hover:text-foreground'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <span className="truncate">{conv.title}</span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 h-6 w-6 shrink-0">
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={14} /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
          >
            <Pin size={14} /> {pinLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              // Let the menu close/unmount before opening the confirm dialog,
              // otherwise it can feel like overlays are "stacked".
              window.setTimeout(() => onDelete(), 0);
            }}
          >
            <Trash2 size={14} /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ChatAside() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    conversations,
    currentConversation,
    setCurrentConversation,
    loadConversations,
    createConversation,
    deleteConversation,
    loadMessages,
    updateConversation,
  } = useChatStore();

  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const confirm = useConfirm();

  useEffect(() => { void loadConversations(); }, [loadConversations]);

  useEffect(() => {
    const onUp = () => void loadConversations();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => window.removeEventListener(BACKEND_UP_EVENT, onUp);
  }, [loadConversations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => conv.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const handleNewConversation = async () => {
    setCreating(true);
    try {
      const conversation = await createConversation(formatNewConversationTitle());
      setCurrentConversation(conversation);
      if (pathname !== '/chat') {
        router.push('/chat');
      }
      await loadMessages(conversation.id);
      notifySuccess('已创建', '新会话已创建');
    } catch (error) {
      notifyError('创建失败', error instanceof Error ? error.message : '无法创建会话');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectConversation = async (conversation: Conversation) => {
    setCurrentConversation(conversation);
    if (pathname !== '/chat') {
      router.push('/chat');
    }
    try {
      await loadMessages(conversation.id);
    } catch (error) {
      notifyError('加载失败', error instanceof Error ? error.message : '无法加载消息');
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: '删除对话？',
      description: '确定删除该会话？此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteConversation(id);
      notifySuccess('已删除', '会话已删除');
    } catch (error) {
      notifyError('删除失败', error instanceof Error ? error.message : '无法删除会话');
    }
  };

  const handleTogglePin = async (conv: Conversation) => {
    const next = !conv.isPinned;
    updateConversation(conv.id, { isPinned: next });
    try {
      await api.conversations.update(conv.id, { isPinned: next });
    } catch (error) {
      updateConversation(conv.id, { isPinned: conv.isPinned });
      notifyError('操作失败', error instanceof Error ? error.message : '无法更新置顶状态');
    }
  };

  const startRename = (conv: Conversation) => {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
  };

  const submitRename = async (conv: Conversation) => {
    const nextTitle = renameValue.trim();
    if (!nextTitle) { setRenamingId(null); return; }
    setRenamingId(null);
    updateConversation(conv.id, { title: nextTitle });
    try {
      await api.conversations.update(conv.id, { title: nextTitle });
      notifySuccess('已保存', '标题已更新');
    } catch (error) {
      notifyError('保存失败', error instanceof Error ? error.message : '无法更新标题');
      void loadConversations();
    }
  };

  const pinned = filtered.filter((c) => c.isPinned);
  const rest = filtered.filter((c) => !c.isPinned);
  const groups = groupByUpdatedAt(rest);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <Button className="w-full" onClick={() => void handleNewConversation()} disabled={creating}>
        <Plus size={16} /> 新会话
      </Button>

      <Input
        placeholder="搜索会话..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 py-1">
          {pinned.length > 0 && (
            <div>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs font-semibold text-muted-foreground">置顶</span>
                <Button variant="ghost" size="icon-sm" className="h-5 w-5" onClick={() => setPinnedOpen((v) => !v)}>
                  {pinnedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </Button>
              </div>
              {pinnedOpen && pinned.map((conv) => (
                renamingId === conv.id ? (
                  <div key={conv.id} className="px-2 py-1">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void submitRename(conv)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(conv);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  </div>
                ) : (
                  <ConvItem
                    key={`pinned-${conv.id}`}
                    conv={conv}
                    isActive={currentConversation?.id === conv.id}
                    onSelect={() => void handleSelectConversation(conv)}
                    onRename={() => startRename(conv)}
                    onTogglePin={() => void handleTogglePin(conv)}
                    onDelete={() => void handleDelete(conv.id)}
                    pinLabel="取消置顶"
                  />
                )
              ))}
            </div>
          )}

          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">{group.label}</p>
              {group.items.map((conv) => (
                renamingId === conv.id ? (
                  <div key={conv.id} className="px-2 py-1">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void submitRename(conv)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(conv);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  </div>
                ) : (
                  <ConvItem
                    key={conv.id}
                    conv={conv}
                    isActive={currentConversation?.id === conv.id}
                    onSelect={() => void handleSelectConversation(conv)}
                    onRename={() => startRename(conv)}
                    onTogglePin={() => void handleTogglePin(conv)}
                    onDelete={() => void handleDelete(conv.id)}
                    pinLabel="置顶"
                  />
                )
              ))}
            </div>
          ))}

          {filtered.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">暂无会话</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
