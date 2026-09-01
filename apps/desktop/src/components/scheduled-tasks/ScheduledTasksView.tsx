import {
  Activity,
  Calendar,
  ChevronDown,
  Clock,
  CloudSun,
  Coffee,
  FileText,
  Globe,
  Languages,
  Lightbulb,
  MapPin,
  MessageCircle,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PenLine,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ScheduledTaskFrequency } from "shared/types";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
  Switch,
} from "ui";
import { getScheduledTaskLabel } from "../../lib/i18n/agent";
import { notifySuccess } from "../../lib/notify";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useScheduledTaskStore } from "../../stores/scheduledTaskStore";
import { CreateTaskDialog } from "./CreateTaskDialog";

type Tab = "tasks" | "runs";

const TEMPLATES: {
  title: string;
  prompt: string;
  frequency: ScheduledTaskFrequency;
  time: string;
  icon: typeof FileText;
}[] = [
  {
    title: "每日财经资讯",
    prompt: "搜索并推送最近 24 小时内最值得关注的 3-5 条财经动态，涵盖股市、宏观政策和热门公司。",
    frequency: "daily",
    time: "08:00",
    icon: FileText,
  },
  {
    title: "工作区整理",
    prompt:
      "请整理当前工作目录中的散乱文件，将能够明确判断归属的文件按类别或项目移入对应子文件夹。",
    frequency: "weekly_mon",
    time: "09:30",
    icon: Calendar,
  },
  {
    title: "每日英语单词",
    prompt: "每天推荐 5 个高频、实用且适合日常交流的英语单词，包含释义、例句和记忆技巧。",
    frequency: "daily",
    time: "09:00",
    icon: Languages,
  },
  {
    title: "每周工作周报",
    prompt:
      "请根据当前工作目录中本周新增或修改的日志、待办、会议纪要、项目记录和文档，起草本周完成的工作总结。",
    frequency: "weekly_fri",
    time: "17:00",
    icon: FileText,
  },
  {
    title: "每日科技新闻",
    prompt: "搜索并推送今天最值得关注的 5 条科技新闻，涵盖 AI、半导体、消费电子和互联网领域。",
    frequency: "daily",
    time: "08:30",
    icon: Globe,
  },
  {
    title: "午间放松推荐",
    prompt: "从冷知识、短片或午后音乐中随机挑一项推荐，并简单介绍理由。帮我在午休时放松一下。",
    frequency: "daily",
    time: "12:30",
    icon: Coffee,
  },
  {
    title: "每日一句话",
    prompt: "推荐一句有启发的名言或哲思，附准确出处和一句简短点评。无法核实出处时不要使用。",
    frequency: "daily",
    time: "07:30",
    icon: MessageCircle,
  },
  {
    title: "每日脑筋急转弯",
    prompt: "出一道有趣的脑筋急转弯或逻辑谜题，只展示题目，等我回复后再揭晓答案。",
    frequency: "daily",
    time: "10:00",
    icon: Lightbulb,
  },
  {
    title: "历史上的今天",
    prompt:
      "告诉我今天在历史上发生过哪些有趣的事，从科技、电影、音乐、体育等领域各挑一件，要有趣且值得一读。",
    frequency: "daily",
    time: "08:30",
    icon: Calendar,
  },
  {
    title: "明日天气播报",
    prompt:
      "请查询并播报明天的天气情况，包括日期、温度范围、天气状况、降水概率、风力以及是否需要带伞或增减衣物。",
    frequency: "daily",
    time: "17:30",
    icon: CloudSun,
  },
  {
    title: "周末去哪玩",
    prompt: "查询周末天气，推荐室内和室外活动各一个，说明地点、理由、时长、费用和准备事项。",
    frequency: "weekly_fri",
    time: "18:00",
    icon: MapPin,
  },
  {
    title: "每日 AI 动态",
    prompt: "搜索并推送最近 24 小时内最值得关注的 3 条 AI 动态，涵盖模型发布、研究突破和行业产品。",
    frequency: "daily",
    time: "09:00",
    icon: Zap,
  },
  {
    title: "睡前一日复盘",
    prompt:
      "引导我做今天的复盘：依次问我「今天完成了什么」「遇到了什么困难」「明天最重要的一件事是什么」，然后帮我总结成简要日志。",
    frequency: "daily",
    time: "22:00",
    icon: Moon,
  },
  {
    title: "每周健身计划",
    prompt:
      "制定本周 4 天健身计划，按推拉腿或上下肢分组，每天列出 4-5 个动作、组数和次数，并提醒注意事项。",
    frequency: "weekly_mon",
    time: "07:30",
    icon: Activity,
  },
];

function formatFrequency(freq: string): string {
  const key = `scheduledTask.freq.${freq}` as Parameters<typeof getScheduledTaskLabel>[0];
  return getScheduledTaskLabel(key);
}

function formatNextRun(date: Date | undefined | null): string {
  if (!date) return "-";
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

export function ScheduledTasksView() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [templateData, setTemplateData] = useState<{
    title: string;
    prompt: string;
    frequency: ScheduledTaskFrequency;
    time: string;
  } | null>(null);

  const { tasks, runs, loading, loadTasks, loadRuns, deleteTask, toggleTask } =
    useScheduledTaskStore();
  const setActiveView = useDesktopShellStore((s) => s.setActiveView);
  const setPrefillComposer = useDesktopShellStore((s) => s.setPrefillComposer);
  const startNewConversation = useChatStore((s) => s.startNewConversation);

  useEffect(() => {
    void loadTasks();
    void loadRuns();
  }, [loadTasks, loadRuns]);

  const handleTemplateClick = (tpl: (typeof TEMPLATES)[0]) => {
    setTemplateData({
      title: tpl.title,
      prompt: tpl.prompt,
      frequency: tpl.frequency,
      time: tpl.time,
    });
    setDialogOpen(true);
  };

  const handleNewTask = () => {
    setTemplateData(null);
    setDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    await deleteTask(id);
    notifySuccess(
      getScheduledTaskLabel("scheduledTask.notify.deletedTitle"),
      getScheduledTaskLabel("scheduledTask.notify.deletedBody"),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div data-tauri-drag-region className="shrink-0" style={{ height: "24px" }} />
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">{getScheduledTaskLabel("scheduledTask.title")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {getScheduledTaskLabel("scheduledTask.subtitle")}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="gap-1.5">
                  <Plus size={16} />
                  {getScheduledTaskLabel("scheduledTask.newTask")}
                  <ChevronDown size={14} className="ml-0.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onClick={() => {
                    startNewConversation();
                    setPrefillComposer("请帮我创建一个定时任务：");
                    setActiveView("chat");
                  }}
                >
                  <MessageSquare size={14} />
                  {getScheduledTaskLabel("scheduledTask.createViaChat")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleNewTask}>
                  <PenLine size={14} />
                  {getScheduledTaskLabel("scheduledTask.createManually")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex gap-1 rounded-lg bg-muted/60 p-1 w-fit">
            <button
              type="button"
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                tab === "tasks"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab("tasks")}
            >
              {getScheduledTaskLabel("scheduledTask.tab.tasks")}
            </button>
            <button
              type="button"
              className={cn(
                "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                tab === "runs"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTab("runs")}
            >
              {getScheduledTaskLabel("scheduledTask.tab.runs")}
            </button>
          </div>

          {tab === "tasks" && (
            <div className="flex flex-col gap-6">
              {loading ? (
                <div className="flex justify-center py-12">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              ) : tasks.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
                  <Clock size={48} strokeWidth={1} />
                  <p className="text-sm">{getScheduledTaskLabel("scheduledTask.emptyState")}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className="group flex items-center justify-between rounded-xl border border-border/60 bg-background px-4 py-3"
                    >
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <span className="font-medium text-sm truncate">{task.title}</span>
                        <span className="text-xs text-muted-foreground truncate">
                          {task.prompt}
                        </span>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {formatFrequency(task.frequency)} {task.time}
                          </span>
                          {task.nextRunAt && (
                            <span>
                              {getScheduledTaskLabel("scheduledTask.nextRun")}:{" "}
                              {formatNextRun(task.nextRunAt)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={task.enabled}
                          onCheckedChange={() => void toggleTask(task.id)}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100"
                            >
                              <MoreHorizontal size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-32">
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => void handleDelete(task.id)}
                            >
                              <Trash2 size={14} />
                              {getScheduledTaskLabel("scheduledTask.action.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-3">
                <h2 className="text-base font-semibold">
                  {getScheduledTaskLabel("scheduledTask.templateHeading")}
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  {TEMPLATES.map((tpl) => {
                    const Icon = tpl.icon;
                    return (
                      <button
                        key={tpl.title}
                        type="button"
                        className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background p-4 text-left transition-colors hover:border-border hover:bg-muted/30"
                        onClick={() => handleTemplateClick(tpl)}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Icon size={18} className="text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-sm">{tpl.title}</p>
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {tpl.prompt}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock size={12} />
                          {formatFrequency(tpl.frequency)} {tpl.time}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === "runs" && (
            <div className="flex flex-col gap-2">
              {runs.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {getScheduledTaskLabel("scheduledTask.runsEmpty")}
                </p>
              ) : (
                runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between rounded-xl border border-border/60 bg-background px-4 py-3"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span className="text-sm font-medium truncate">
                        {run.taskTitle ?? run.taskId}
                      </span>
                      {run.result && (
                        <span className="text-xs text-muted-foreground line-clamp-2">
                          {run.result}
                        </span>
                      )}
                      {run.error && (
                        <span className="text-xs text-destructive line-clamp-1">{run.error}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          run.status === "completed" &&
                            "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
                          run.status === "failed" &&
                            "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
                          run.status === "running" &&
                            "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
                          run.status === "pending" &&
                            "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
                        )}
                      >
                        {getScheduledTaskLabel(
                          `scheduledTask.runStatus.${run.status}` as Parameters<
                            typeof getScheduledTaskLabel
                          >[0],
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatNextRun(run.startedAt)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          <CreateTaskDialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) setTemplateData(null);
            }}
            initialTitle={templateData?.title}
            initialPrompt={templateData?.prompt}
            initialFrequency={templateData?.frequency}
            initialTime={templateData?.time}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
