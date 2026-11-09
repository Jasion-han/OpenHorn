import { useRef, useState } from "react";
import type { RecipeParameter, RecipeSpec } from "shared/types";
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
  Textarea,
} from "ui";
import { getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { workbenchError } from "../../lib/workbenchApi";
import { useChatStore } from "../../stores/chatStore";
import { useProjectStore } from "../../stores/projectStore";
import { DiscardChangesDialog } from "./DiscardChangesDialog";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
function parametersFor(prompt: string, current: RecipeParameter[]): RecipeParameter[] {
  const keys = [
    ...new Set(
      [...prompt.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g)].map((m) => m[1]),
    ),
  ];
  return keys.map(
    (key) =>
      current.find((p) => p.key === key) ?? { key, label: key, type: "text", required: true },
  );
}
export function RecipeEditor({
  spec,
  onClose,
  onSave,
}: {
  spec: RecipeSpec;
  onClose(): void;
  onSave(spec: RecipeSpec): Promise<void>;
}) {
  const [initialDraft] = useState(() => ({
    ...structuredClone(spec),
    parameters: parametersFor(spec.promptTemplate, spec.parameters),
  }));
  const [draft, setDraft] = useState(() => structuredClone(initialDraft));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [skillsText, setSkillsText] = useState(spec.requirements.skills.join(", "));
  const [mcpText, setMcpText] = useState(spec.requirements.mcpServers.join(", "));
  const [error, setError] = useState<string | null>(null);
  const requestClose = () => {
    if (submitting.current) return;
    if (
      JSON.stringify(draft) !== JSON.stringify(initialDraft) ||
      skillsText !== spec.requirements.skills.join(", ") ||
      mcpText !== spec.requirements.mcpServers.join(", ")
    ) {
      setConfirmDiscard(true);
    } else onClose();
  };
  const projects = useProjectStore((s) => s.projects);
  const channels = useChatStore((s) => s.channels);
  const selectedChannel = channels.find(
    (channel) => channel.id === draft.channelId && channel.enabled,
  );
  const missingProject =
    !!draft.projectId && !projects.some((project) => project.id === draft.projectId);
  const missingChannel = !!draft.channelId && !selectedChannel;
  const missingModel =
    !!draft.modelId &&
    !selectedChannel?.models.some((model) => model.modelId === draft.modelId && model.enabled);
  const update = (data: Partial<RecipeSpec>) => setDraft((old) => ({ ...old, ...data }));
  const parameter = (key: string, value: Partial<RecipeParameter>) =>
    update({ parameters: draft.parameters.map((p) => (p.key === key ? { ...p, ...value } : p)) });
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        requirements: {
          ...draft.requirements,
          skills: skillsText
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
          mcpServers: mcpText
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      onClose();
    } catch (error) {
      setError(workbenchError(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{label("workbench.recipes.edit")}</DialogTitle>
            <DialogDescription>{label("workbench.recipes.promptHint")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="recipe-title">{label("workbench.recipes.name")}</Label>
              <Input
                id="recipe-title"
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
                maxLength={160}
                required
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recipe-description">{label("workbench.recipes.description")}</Label>
              <Input
                id="recipe-description"
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
                maxLength={2000}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recipe-prompt">{label("workbench.recipes.prompt")}</Label>
              <Textarea
                id="recipe-prompt"
                value={draft.promptTemplate}
                onChange={(e) =>
                  update({
                    promptTemplate: e.target.value,
                    parameters: parametersFor(e.target.value, draft.parameters),
                  })
                }
                className="min-h-28"
                maxLength={64000}
                required
                disabled={busy}
              />
            </div>
            {draft.parameters.length > 0 && (
              <fieldset className="space-y-3 border-t pt-3">
                <legend className="pr-2 text-sm font-medium">
                  {label("workbench.recipes.parameters")}
                </legend>
                {draft.parameters.map((p) => (
                  <div key={p.key} className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label
                        className="min-w-20 text-xs text-muted-foreground"
                        htmlFor={`param-label-${p.key}`}
                      >{`{{${p.key}}}`}</Label>
                      <Input
                        id={`param-label-${p.key}`}
                        aria-label={`${p.key} ${label("workbench.recipes.parameterLabel")}`}
                        className="min-w-0 flex-1 basis-36"
                        value={p.label}
                        onChange={(e) => parameter(p.key, { label: e.target.value })}
                        maxLength={160}
                        required
                        disabled={busy}
                      />
                      <label
                        htmlFor={`param-required-${p.key}`}
                        className="flex items-center gap-1.5 text-xs"
                      >
                        <Checkbox
                          id={`param-required-${p.key}`}
                          checked={p.required}
                          onCheckedChange={(v) => parameter(p.key, { required: v === true })}
                          disabled={busy}
                        />
                        {label("workbench.recipes.required")}
                      </label>
                    </div>
                    <details className="text-xs text-muted-foreground">
                      <summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        {label("workbench.recipes.parameterOptions")}
                      </summary>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`param-default-${p.key}`}>
                            {label("workbench.recipes.defaultValue")}
                          </Label>
                          <Input
                            id={`param-default-${p.key}`}
                            value={p.defaultValue ?? ""}
                            onChange={(e) => parameter(p.key, { defaultValue: e.target.value })}
                            maxLength={16000}
                            disabled={busy}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`param-type-${p.key}`}>
                            {label("workbench.recipes.parameterType")}
                          </Label>
                          <select
                            id={`param-type-${p.key}`}
                            className={selectClass}
                            value={p.type}
                            onChange={(e) =>
                              parameter(p.key, { type: e.target.value as RecipeParameter["type"] })
                            }
                            disabled={busy}
                          >
                            <option value="text">{label("workbench.recipes.text")}</option>
                            <option value="multiline">
                              {label("workbench.recipes.multiline")}
                            </option>
                            <option value="number">{label("workbench.recipes.number")}</option>
                          </select>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </fieldset>
            )}
            <details className="border-t pt-3">
              <summary className="w-fit cursor-pointer rounded py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                {label("workbench.recipes.advancedSettings")}
              </summary>
              <div className="mt-3 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="recipe-project">{label("workbench.recipes.project")}</Label>
                    <select
                      id="recipe-project"
                      className={selectClass}
                      value={draft.projectId ?? ""}
                      onChange={(e) => update({ projectId: e.target.value || undefined })}
                      disabled={busy}
                    >
                      <option value="">{label("workbench.recipes.noProject")}</option>
                      {missingProject && (
                        <option value={draft.projectId} disabled>
                          {label("workbench.errors.projectMissing")}
                        </option>
                      )}
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="recipe-channel">{label("workbench.recipes.channel")}</Label>
                    <select
                      id="recipe-channel"
                      className={selectClass}
                      value={draft.channelId ?? ""}
                      onChange={(e) =>
                        update({ channelId: e.target.value || undefined, modelId: undefined })
                      }
                      disabled={busy}
                    >
                      <option value="">{label("workbench.recipes.defaultChannel")}</option>
                      {missingChannel && (
                        <option value={draft.channelId} disabled>
                          {label("workbench.errors.channelMissing")}
                        </option>
                      )}
                      {channels
                        .filter((c) => c.enabled)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="recipe-model">{label("workbench.recipes.model")}</Label>
                    <select
                      id="recipe-model"
                      className={selectClass}
                      value={draft.modelId ?? ""}
                      onChange={(e) => update({ modelId: e.target.value || undefined })}
                      disabled={busy || !selectedChannel}
                    >
                      <option value="">{label("workbench.recipes.defaultModel")}</option>
                      {missingModel && (
                        <option value={draft.modelId} disabled>
                          {label("workbench.recipes.unavailableModel")}
                        </option>
                      )}
                      {channels
                        .find((c) => c.id === draft.channelId)
                        ?.models.filter((m) => m.enabled)
                        .map((m) => (
                          <option key={m.id} value={m.modelId}>
                            {m.displayName}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="recipe-format">{label("workbench.recipes.format")}</Label>
                    <select
                      id="recipe-format"
                      className={selectClass}
                      value={draft.outputFormat}
                      onChange={(e) =>
                        update({ outputFormat: e.target.value as RecipeSpec["outputFormat"] })
                      }
                      disabled={busy}
                    >
                      <option value="markdown">Markdown</option>
                      <option value="html">HTML</option>
                      <option value="openui">OpenUI</option>
                    </select>
                  </div>
                </div>
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-sm font-medium">
                    {label("workbench.recipes.requirements")}
                  </legend>
                  <label
                    htmlFor="recipe-require-workspace"
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id="recipe-require-workspace"
                      checked={draft.requirements.workspace}
                      onCheckedChange={(v) =>
                        update({ requirements: { ...draft.requirements, workspace: v === true } })
                      }
                      disabled={busy}
                    />
                    {label("workbench.recipes.workspace")}
                  </label>
                  <label
                    htmlFor="recipe-require-search"
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id="recipe-require-search"
                      checked={draft.requirements.webSearch}
                      onCheckedChange={(v) =>
                        update({ requirements: { ...draft.requirements, webSearch: v === true } })
                      }
                      disabled={busy}
                    />
                    {label("workbench.recipes.webSearch")}
                  </label>
                  {(["skills", "mcpServers"] as const).map((kind) => (
                    <div key={kind} className="space-y-1.5">
                      <Label htmlFor={`recipe-${kind}`}>
                        {label(
                          kind === "skills" ? "workbench.recipes.skills" : "workbench.recipes.mcp",
                        )}
                      </Label>
                      <Input
                        id={`recipe-${kind}`}
                        value={kind === "skills" ? skillsText : mcpText}
                        onChange={(e) =>
                          (kind === "skills" ? setSkillsText : setMcpText)(e.target.value)
                        }
                        disabled={busy}
                      />
                    </div>
                  ))}
                </fieldset>
              </div>
            </details>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
                {label("workbench.recipes.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={busy || !draft.title.trim() || !draft.promptTemplate.trim()}
              >
                {label(busy ? "workbench.recipes.busy" : "workbench.recipes.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog
        open={confirmDiscard}
        onKeep={() => setConfirmDiscard(false)}
        onDiscard={onClose}
      />
    </>
  );
}
