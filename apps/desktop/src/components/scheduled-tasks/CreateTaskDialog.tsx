import { useEffect, useRef, useState } from "react";
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
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";
import { useScheduledTaskStore } from "../../stores/scheduledTaskStore";
import type { RecipeScheduleHandoff } from "../../stores/workbenchStore";
import { DiscardChangesNotice } from "../workbench/DiscardChangesNotice";

const FREQUENCIES: ScheduledTaskFrequency[] = [
  "daily",
  "weekly_mon",
  "weekly_tue",
  "weekly_wed",
  "weekly_thu",
  "weekly_fri",
  "weekly_sat",
  "weekly_sun",
];
interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTaskId?: string;
  initialTitle?: string;
  initialPrompt?: string;
  initialFrequency?: ScheduledTaskFrequency;
  initialTime?: string;
  initialNotifyOnComplete?: boolean;
  recipeSchedule?: RecipeScheduleHandoff | null;
  recipeSource?: { title: string; version: number } | null;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  editTaskId,
  initialTitle = "",
  initialPrompt = "",
  initialFrequency = "daily",
  initialTime = "09:00",
  initialNotifyOnComplete = true,
  recipeSchedule,
  recipeSource,
}: CreateTaskDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [frequency, setFrequency] = useState<ScheduledTaskFrequency>(initialFrequency);
  const [time, setTime] = useState(initialTime);
  const [notify, setNotify] = useState(initialNotifyOnComplete);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const submission = useRef<symbol | null>(null);
  const generation = useRef(0);
  const createTask = useScheduledTaskStore((s) => s.createTask);
  const updateTask = useScheduledTaskStore((s) => s.updateTask);
  const isEdit = !!editTaskId;
  const source = recipeSchedule
    ? { title: recipeSchedule.title, version: recipeSchedule.version }
    : recipeSource;
  const lockedPrompt = !!source;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new draft/task identity must invalidate an old submit even when its visible fields match
  useEffect(() => {
    generation.current++;
    submission.current = null;
    setSaving(false);
    setError("");
    setConfirmDiscard(false);
    if (open) {
      setTitle(initialTitle);
      setPrompt(initialPrompt);
      setFrequency(initialFrequency);
      setTime(initialTime);
      setNotify(initialNotifyOnComplete);
    }
    return () => {
      generation.current++;
    };
  }, [
    open,
    editTaskId,
    recipeSchedule?.handoffId,
    initialTitle,
    initialPrompt,
    initialFrequency,
    initialTime,
    initialNotifyOnComplete,
  ]);
  const requestClose = () => {
    if (submission.current) return;
    if (
      title !== initialTitle ||
      (!lockedPrompt && prompt !== initialPrompt) ||
      frequency !== initialFrequency ||
      time !== initialTime ||
      notify !== initialNotifyOnComplete
    )
      setConfirmDiscard(true);
    else onOpenChange(false);
  };
  const handleSave = async () => {
    if (
      !open ||
      submission.current ||
      !title.trim() ||
      !prompt.trim() ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
    )
      return;
    const token = Symbol("schedule-submit"),
      epoch = generation.current;
    submission.current = token;
    setSaving(true);
    setError("");
    const current = () => submission.current === token && generation.current === epoch;
    try {
      let success = false;
      if (isEdit && editTaskId) {
        success = !!(await updateTask(editTaskId, {
          title: title.trim(),
          ...(!lockedPrompt ? { prompt: prompt.trim() } : {}),
          frequency,
          time,
          notifyOnComplete: notify,
        }));
      } else if (recipeSchedule) {
        const result = await workbenchApi.recipes.schedule(recipeSchedule.recipeId, {
          version: recipeSchedule.version,
          values: recipeSchedule.values,
          frequency,
          time,
          title: title.trim(),
          notifyOnComplete: notify,
          requestId: recipeSchedule.handoffId,
        });
        success = !!result.task;
        if (current() && success) await useScheduledTaskStore.getState().loadTasks();
      } else {
        success = !!(await createTask({
          title: title.trim(),
          prompt: prompt.trim(),
          frequency,
          time,
          notifyOnComplete: notify,
        }));
      }
      if (!current()) return;
      if (!success) throw new Error("Schedule could not be saved");
      notifySuccess(
        getScheduledTaskLabel(
          isEdit ? "scheduledTask.notify.updatedTitle" : "scheduledTask.notify.createdTitle",
        ),
        getScheduledTaskLabel(
          isEdit ? "scheduledTask.notify.updatedBody" : "scheduledTask.notify.createdBody",
        ),
      );
      onOpenChange(false);
    } catch (failure) {
      if (!current()) return;
      const message = recipeSchedule
        ? workbenchError(failure)
        : getScheduledTaskLabel(
            isEdit
              ? "scheduledTask.notify.updateFailedBody"
              : "scheduledTask.notify.createFailedBody",
          );
      setError(message);
      notifyError(
        getScheduledTaskLabel(
          isEdit
            ? "scheduledTask.notify.updateFailedTitle"
            : "scheduledTask.notify.createFailedTitle",
        ),
        message,
      );
    } finally {
      if (current()) {
        submission.current = null;
        setSaving(false);
      }
    }
  };
  const promptField = (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="scheduled-task-prompt" className="text-sm font-medium">
        {getScheduledTaskLabel("scheduledTask.fieldPrompt")}{" "}
        <span className="text-destructive">*</span>
      </Label>
      <Textarea
        id="scheduled-task-prompt"
        value={prompt}
        readOnly={lockedPrompt}
        aria-describedby={lockedPrompt ? "scheduled-recipe-locked" : undefined}
        disabled={saving}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={getScheduledTaskLabel("scheduledTask.fieldPromptPlaceholder")}
        rows={4}
      />
    </div>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (confirmDiscard) {
            event.preventDefault();
            setConfirmDiscard(false);
          }
        }}
        className="max-h-[85dvh] max-w-lg overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {getScheduledTaskLabel(
              isEdit ? "scheduledTask.editTitle" : "scheduledTask.createTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {getScheduledTaskLabel(
              isEdit
                ? source
                  ? "scheduledTask.recipe.editSubtitle"
                  : "scheduledTask.editSubtitle"
                : source
                  ? "scheduledTask.recipe.subtitle"
                  : "scheduledTask.createSubtitle",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {source ? (
            <div
              className="space-y-1 text-xs text-muted-foreground"
              data-testid="scheduled-recipe-source"
            >
              <p>
                {getScheduledTaskLabel("scheduledTask.recipe.source")
                  .replace("{title}", source.title)
                  .replace("{version}", String(source.version))}
              </p>
              <p id="scheduled-recipe-locked">
                {getScheduledTaskLabel("scheduledTask.recipe.locked")}
              </p>
            </div>
          ) : null}
          {recipeSchedule?.parameters?.length ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {getScheduledTaskLabel("scheduledTask.recipe.parameters")}
              </p>
              <dl className="grid max-h-32 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 overflow-y-auto text-xs text-muted-foreground">
                {recipeSchedule.parameters.map((parameter, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: summary rows are immutable within this handoff and labels may repeat
                  <div key={`${parameter.label}-${index}`} className="contents">
                    <dt className="max-w-40 break-words">{parameter.label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{parameter.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scheduled-task-name" className="text-sm font-medium">
              {getScheduledTaskLabel("scheduledTask.fieldName")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="scheduled-task-name"
              value={title}
              maxLength={160}
              disabled={saving}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={getScheduledTaskLabel("scheduledTask.fieldNamePlaceholder")}
            />
          </div>
          {!isEdit ? (
            <p className="text-xs text-muted-foreground">
              {getScheduledTaskLabel("scheduledTask.createHint")}
            </p>
          ) : null}
          {lockedPrompt ? (
            <details>
              <summary className="w-fit cursor-pointer rounded py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                {getScheduledTaskLabel("scheduledTask.recipe.viewPrompt")}
              </summary>
              <div className="mt-2">{promptField}</div>
            </details>
          ) : (
            promptField
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scheduled-task-time" className="text-sm font-medium">
              {getScheduledTaskLabel("scheduledTask.fieldTime")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={frequency}
                disabled={saving}
                onValueChange={(value) => setFrequency(value as ScheduledTaskFrequency)}
              >
                <SelectTrigger
                  className="w-[140px]"
                  aria-label={getScheduledTaskLabel("scheduledTask.fieldFrequency")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {getScheduledTaskLabel(`scheduledTask.freq.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="scheduled-task-time"
                type="time"
                value={time}
                disabled={saving}
                onChange={(event) => setTime(event.target.value)}
                className="w-[140px]"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="scheduled-task-notify"
              checked={notify}
              disabled={saving}
              onCheckedChange={(value) => setNotify(value === true)}
            />
            <Label htmlFor="scheduled-task-notify" className="cursor-pointer text-sm">
              {getScheduledTaskLabel("scheduledTask.fieldNotify")}
            </Label>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {confirmDiscard ? (
          <DiscardChangesNotice
            open={confirmDiscard}
            onKeep={() => setConfirmDiscard(false)}
            onDiscard={() => {
              setConfirmDiscard(false);
              onOpenChange(false);
            }}
          />
        ) : (
          <DialogFooter>
            <Button variant="ghost" disabled={saving} onClick={requestClose}>
              {getScheduledTaskLabel("scheduledTask.cancel")}
            </Button>
            <Button
              onClick={() => void handleSave()}
              disabled={
                saving || !title.trim() || !prompt.trim() || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
              }
            >
              {getScheduledTaskLabel(
                saving
                  ? "scheduledTask.saving"
                  : isEdit
                    ? "scheduledTask.saveEdit"
                    : "scheduledTask.save",
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
