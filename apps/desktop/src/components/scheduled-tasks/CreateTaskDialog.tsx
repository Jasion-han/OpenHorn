import { useEffect, useState } from "react";
import type { ScheduledTaskFrequency } from "shared/types";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "ui";
import { getScheduledTaskLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess } from "../../lib/notify";
import { useScheduledTaskStore } from "../../stores/scheduledTaskStore";

const FREQUENCIES: { value: ScheduledTaskFrequency; label: string }[] = [
  { value: "daily", label: getScheduledTaskLabel("scheduledTask.freq.daily") },
  { value: "weekly_mon", label: getScheduledTaskLabel("scheduledTask.freq.weekly_mon") },
  { value: "weekly_tue", label: getScheduledTaskLabel("scheduledTask.freq.weekly_tue") },
  { value: "weekly_wed", label: getScheduledTaskLabel("scheduledTask.freq.weekly_wed") },
  { value: "weekly_thu", label: getScheduledTaskLabel("scheduledTask.freq.weekly_thu") },
  { value: "weekly_fri", label: getScheduledTaskLabel("scheduledTask.freq.weekly_fri") },
  { value: "weekly_sat", label: getScheduledTaskLabel("scheduledTask.freq.weekly_sat") },
  { value: "weekly_sun", label: getScheduledTaskLabel("scheduledTask.freq.weekly_sun") },
];

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTaskId?: string;
  initialTitle?: string;
  initialPrompt?: string;
  initialFrequency?: ScheduledTaskFrequency;
  initialTime?: string;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  editTaskId,
  initialTitle = "",
  initialPrompt = "",
  initialFrequency = "daily",
  initialTime = "09:00",
}: CreateTaskDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [frequency, setFrequency] = useState<ScheduledTaskFrequency>(initialFrequency);
  const [time, setTime] = useState(initialTime);
  const [notify, setNotify] = useState(true);
  const [saving, setSaving] = useState(false);
  const createTask = useScheduledTaskStore((s) => s.createTask);
  const updateTask = useScheduledTaskStore((s) => s.updateTask);

  const isEdit = Boolean(editTaskId);

  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setPrompt(initialPrompt);
      setFrequency(initialFrequency);
      setTime(initialTime);
      setNotify(true);
    }
  }, [open, initialTitle, initialPrompt, initialFrequency, initialTime]);

  const handleSave = async () => {
    if (!title.trim() || !prompt.trim()) return;
    setSaving(true);

    if (isEdit && editTaskId) {
      const updated = await updateTask(editTaskId, {
        title: title.trim(),
        prompt: prompt.trim(),
        frequency,
        time,
        notifyOnComplete: notify,
      });
      setSaving(false);
      if (updated) {
        notifySuccess(
          getScheduledTaskLabel("scheduledTask.notify.updatedTitle"),
          getScheduledTaskLabel("scheduledTask.notify.updatedBody"),
        );
        onOpenChange(false);
      } else {
        notifyError(
          getScheduledTaskLabel("scheduledTask.notify.updateFailedTitle"),
          getScheduledTaskLabel("scheduledTask.notify.updateFailedBody"),
        );
      }
      return;
    }

    const task = await createTask({
      title: title.trim(),
      prompt: prompt.trim(),
      frequency,
      time,
      notifyOnComplete: notify,
    });
    setSaving(false);
    if (task) {
      notifySuccess(
        getScheduledTaskLabel("scheduledTask.notify.createdTitle"),
        getScheduledTaskLabel("scheduledTask.notify.createdBody"),
      );
      onOpenChange(false);
    } else {
      notifyError(
        getScheduledTaskLabel("scheduledTask.notify.createFailedTitle"),
        getScheduledTaskLabel("scheduledTask.notify.createFailedBody"),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? getScheduledTaskLabel("scheduledTask.editTitle")
              : getScheduledTaskLabel("scheduledTask.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? getScheduledTaskLabel("scheduledTask.editSubtitle")
              : getScheduledTaskLabel("scheduledTask.createSubtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm font-medium">
              {getScheduledTaskLabel("scheduledTask.fieldName")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={getScheduledTaskLabel("scheduledTask.fieldNamePlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-sm font-medium">
              Prompt {getScheduledTaskLabel("scheduledTask.fieldPrompt").replace("Prompt ", "")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={getScheduledTaskLabel("scheduledTask.fieldPromptPlaceholder")}
              rows={4}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-sm font-medium">
              {getScheduledTaskLabel("scheduledTask.fieldTime")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as ScheduledTaskFrequency)}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-[140px]"
              />
            </div>
          </div>

          {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix Checkbox renders its own input */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} />
            <span className="text-sm">{getScheduledTaskLabel("scheduledTask.fieldNotify")}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {getScheduledTaskLabel("scheduledTask.cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || !title.trim() || !prompt.trim()}
          >
            {saving
              ? getScheduledTaskLabel("scheduledTask.saving")
              : isEdit
                ? getScheduledTaskLabel("scheduledTask.saveEdit")
                : getScheduledTaskLabel("scheduledTask.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
