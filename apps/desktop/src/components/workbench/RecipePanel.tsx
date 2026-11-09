import { ArrowUpRight, FileText, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { missingRecipeCapabilities, renderRecipePrompt } from "shared/recipes";
import type { RecipeSpec, RecipeValues, TaskRecipe } from "shared/types";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Textarea,
} from "ui";
import { formatWorkbenchLabel, getWorkbenchLabel as label } from "../../lib/i18n/agent";
import { notifySuccess } from "../../lib/notify";
import { emptyRecipe, recipePresets } from "../../lib/recipePresets";
import { createServerApi } from "../../lib/serverApi";
import { resolveEnabledSkills } from "../../lib/sidecarRunSupport";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import { workbenchApi, workbenchError } from "../../lib/workbenchApi";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSidecarStore } from "../../stores/sidecarStore";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import { RecipeEditor } from "./RecipeEditor";

const api = createServerApi();
function missingLabel(value: string): string {
  if (value.startsWith("skill:"))
    return formatWorkbenchLabel("workbench.recipes.missingSkill", { name: value.slice(6) });
  if (value.startsWith("mcp:"))
    return formatWorkbenchLabel("workbench.recipes.missingMcp", { name: value.slice(4) });
  return label(
    value === "workspace"
      ? "workbench.recipes.missingWorkspace"
      : "workbench.recipes.missingSearch",
  );
}
export function RecipePanel() {
  const [recipes, setRecipes] = useState<TaskRecipe[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [values, setValues] = useState<RecipeValues>({});
  const [editor, setEditor] = useState<{ spec: RecipeSpec; id?: string; version?: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const draft = useWorkbenchStore((s) => s.recipeDraft);
  const projects = useProjectStore((s) => s.projects);
  const channels = useChatStore((s) => s.channels);
  const requestEpoch = useRef(0);
  const submitting = useRef(false);
  const selected = recipes.find((r) => r.id === selectedId);
  const loadEpoch = useRef(0);
  const formVersion = useRef<string | null>(null);
  const changeValue = (key: string, value: string) => {
    setValues((old) => ({ ...old, [key]: value }));
    setError(null);
    setMissing([]);
  };
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setListError(null);
    try {
      const result = await workbenchApi.recipes.list();
      if (loadEpoch.current !== epoch) return;
      setRecipes(result.recipes);
      setSelectedId((id) =>
        result.recipes.some((r) => r.id === id) ? id : (result.recipes[0]?.id ?? null),
      );
    } catch (error) {
      if (loadEpoch.current === epoch) setListError(workbenchError(error));
    } finally {
      if (loadEpoch.current === epoch) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const retry = () => {
      void load();
    };
    window.addEventListener(BACKEND_UP_EVENT, retry);
    return () => {
      loadEpoch.current++;
      requestEpoch.current++;
      window.removeEventListener(BACKEND_UP_EVENT, retry);
    };
  }, [load]);
  useEffect(() => {
    if (draft === null) return;
    setEditor({ spec: emptyRecipe(draft) });
    useWorkbenchStore.getState().setRecipeDraft(null);
  }, [draft]);
  useEffect(() => {
    const recipe = recipes.find((r) => r.id === selectedId);
    const identity = recipe ? `${recipe.id}:${recipe.version}` : null;
    if (formVersion.current === identity) return;
    formVersion.current = identity;
    setValues(
      Object.fromEntries(recipe?.spec.parameters.map((p) => [p.key, p.defaultValue ?? ""]) ?? []),
    );
    setMissing([]);
    setError(null);
    requestEpoch.current++;
  }, [selectedId, recipes]);
  const save = async (spec: RecipeSpec) => {
    const result = editor?.id
      ? await workbenchApi.recipes.update(editor.id, spec, editor.version ?? 1)
      : await workbenchApi.recipes.create(spec);
    await load();
    setSelectedId(result.recipe.id);
    notifySuccess(label("workbench.recipes.saved"), spec.title);
  };
  const preflight = async (recipe: TaskRecipe) => {
    renderRecipePrompt(recipe.spec, values);
    const [skills, mcp] = await Promise.all([resolveEnabledSkills(), api.mcp.listServers()]);
    const servers = mcp.servers as Array<{ name: string; isEnabled: boolean }>;
    const available = useChatStore.getState().channels;
    const channel =
      available.find((c) => c.id === recipe.spec.channelId) ??
      available.find((c) => c.enabled && c.isDefault);
    const appTools = channel?.protocol !== "acp";
    const found = missingRecipeCapabilities(recipe.spec.requirements, {
      skills: appTools ? skills.map((s) => s.name) : [],
      mcpServers: appTools ? servers.filter((s) => s.isEnabled).map((s) => s.name) : [],
      workspace:
        !!recipe.spec.projectId &&
        useProjectStore.getState().projects.some((p) => p.id === recipe.spec.projectId),
      webSearch: appTools,
    });
    setMissing(found);
    return found.length === 0;
  };
  const owns = (epoch: number) =>
    epoch === requestEpoch.current &&
    useDesktopShellStore.getState().activeView === "workbench" &&
    useWorkbenchStore.getState().tab === "recipes";
  const run = async () => {
    if (!selected || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const epoch = ++requestEpoch.current;
    try {
      if (!isDesktopRuntime()) {
        setError(label("workbench.recipes.desktopRequired"));
        return;
      }
      if (useChatStore.getState().isStreaming) {
        setError(label("workbench.recipes.running"));
        return;
      }
      if (!(await preflight(selected)) || !owns(epoch)) return;
      const project = useProjectStore
        .getState()
        .projects.find((p) => p.id === selected.spec.projectId);
      const workspace = await useSidecarStore.getState().ensureWorkspace(project?.rootPath);
      if (!owns(epoch)) return;
      if (!workspace) {
        setError(
          label(
            project ? "workbench.recipes.missingWorkspace" : "workbench.recipes.desktopRequired",
          ),
        );
        return;
      }
      const prepared = await workbenchApi.recipes.prepare(selected.id, selected.version, values);
      if (!owns(epoch)) return;
      await useChatStore.getState().loadConversations();
      if (!owns(epoch)) return;
      await useChatStore.getState().selectConversation(prepared.conversationId);
      if (
        !owns(epoch) ||
        useChatStore.getState().currentConversation?.id !== prepared.conversationId
      )
        return;
      useDesktopShellStore.getState().setPendingPrompt({
        text: prepared.prompt,
        files: [],
        conversationId: prepared.conversationId,
        requirements: prepared.requirements,
      });
      useDesktopShellStore.getState().setActiveView("chat");
    } catch (error) {
      if (owns(epoch))
        setError(
          error instanceof Error && error.name === "RecipeValidationError"
            ? label("workbench.errors.invalidParameters")
            : workbenchError(error),
        );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const schedule = () => {
    if (!selected || busy) return;
    setError(null);
    setMissing([]);
    if (selected.spec.outputFormat !== "markdown") {
      setError(label("workbench.errors.scheduleFormat"));
      return;
    }
    try {
      const rendered = renderRecipePrompt(selected.spec, values);
      useWorkbenchStore.getState().openRecipeSchedule({
        recipeId: selected.id,
        version: selected.version,
        title: selected.spec.title,
        prompt: rendered.prompt,
        values: rendered.values,
        parameters: selected.spec.parameters.map((p) => ({
          label: p.label,
          value: String(rendered.values[p.key] ?? ""),
        })),
      });
    } catch {
      setError(label("workbench.errors.invalidParameters"));
    }
  };
  const remove = async () => {
    if (!selected || busy || !window.confirm(label("workbench.recipes.deleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await workbenchApi.recipes.delete(selected.id);
      await load();
    } catch (error) {
      setError(workbenchError(error));
    } finally {
      setBusy(false);
    }
  };
  const visible = recipes.filter((r) =>
    r.spec.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  let preview: string | null = null;
  if (selected) {
    try {
      preview = renderRecipePrompt(selected.spec, values).prompt;
    } catch {
      /* Incomplete parameters are explained in the preview. */
    }
  }
  const bindings = selected
    ? [
        selected.spec.projectId
          ? (projects.find((p) => p.id === selected.spec.projectId)?.name ??
            label("workbench.errors.projectMissing"))
          : label("workbench.recipes.noProject"),
        selected.spec.channelId
          ? (channels.find((c) => c.id === selected.spec.channelId)?.name ??
            label("workbench.errors.channelMissing"))
          : label("workbench.recipes.defaultChannel"),
        selected.spec.modelId,
        formatWorkbenchLabel("workbench.recipes.version", { version: selected.version }),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-3 border-b pb-4 lg:border-b-0 lg:border-r lg:pr-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {formatWorkbenchLabel("workbench.recipes.count", { count: recipes.length })}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy}>
                <Plus size={14} />
                {label("workbench.recipes.new")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditor({ spec: emptyRecipe() })}>
                {label("workbench.recipes.blank")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{label("workbench.recipes.templates")}</DropdownMenuLabel>
              {recipePresets().map((spec) => (
                <DropdownMenuItem key={spec.title} onClick={() => setEditor({ spec })}>
                  <FileText size={14} />
                  {spec.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {recipes.length > 0 && (
          <Input
            aria-label={label("workbench.recipes.search")}
            placeholder={label("workbench.recipes.search")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {loading && (
          <output className="text-sm text-muted-foreground">
            {label("workbench.recipes.loading")}
          </output>
        )}
        {listError && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{listError}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void load()}
              disabled={busy || loading}
            >
              {label("workbench.recipes.retry")}
            </Button>
          </div>
        )}
        <nav
          aria-label={label("workbench.recipes.title")}
          className="max-h-60 space-y-1 overflow-y-auto lg:max-h-[60vh]"
        >
          {visible.map((recipe) => (
            <button
              type="button"
              key={recipe.id}
              disabled={busy}
              aria-current={recipe.id === selectedId ? "true" : undefined}
              onClick={() => setSelectedId(recipe.id)}
              className={cn(
                "w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                recipe.id === selectedId ? "bg-muted font-medium" : "hover:bg-muted/50",
              )}
            >
              <span className="block break-words">{recipe.spec.title}</span>
            </button>
          ))}
        </nav>
        {!loading && !listError && recipes.length === 0 && (
          <p className="text-sm text-muted-foreground">{label("workbench.recipes.empty")}</p>
        )}
        {!loading && recipes.length > 0 && visible.length === 0 && (
          <div aria-live="polite" className="space-y-2 text-sm text-muted-foreground">
            <p>{label("workbench.recipes.noResults")}</p>
            <Button size="sm" variant="ghost" onClick={() => setFilter("")}>
              {label("workbench.search.clear")}
            </Button>
          </div>
        )}
      </aside>
      <section className="min-w-0 space-y-5">
        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 text-sm text-destructive"
          >
            <p>{error}</p>
          </div>
        )}
        {selected ? (
          <>
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <h2 className="break-words text-xl font-medium">{selected.spec.title}</h2>
                {selected.spec.description && (
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {selected.spec.description}
                  </p>
                )}
                <p className="break-words text-xs text-muted-foreground">{bindings}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={label("workbench.recipes.more")}
                    disabled={busy}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      setEditor({ spec: selected.spec, id: selected.id, version: selected.version })
                    }
                  >
                    <Pencil size={14} />
                    {label("workbench.recipes.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => void remove()}>
                    <Trash2 size={14} />
                    {label("workbench.recipes.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </header>
            <form
              className="max-w-2xl space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {selected.spec.parameters.map((p) => (
                <div key={p.key} className="space-y-1.5">
                  <Label htmlFor={`recipe-value-${p.key}`}>
                    {p.label}
                    {p.required ? " *" : ""}
                  </Label>
                  {p.type === "multiline" ? (
                    <Textarea
                      id={`recipe-value-${p.key}`}
                      value={String(values[p.key] ?? "")}
                      onChange={(event) => changeValue(p.key, event.target.value)}
                      required={p.required}
                      disabled={busy}
                    />
                  ) : (
                    <Input
                      id={`recipe-value-${p.key}`}
                      type={p.type === "number" ? "number" : "text"}
                      step={p.type === "number" ? "any" : undefined}
                      value={String(values[p.key] ?? "")}
                      onChange={(event) => changeValue(p.key, event.target.value)}
                      required={p.required}
                      disabled={busy}
                    />
                  )}
                </div>
              ))}
              {missing.length > 0 && (
                <div role="alert" className="space-y-1 text-sm text-destructive">
                  {missing.map((item) => (
                    <p key={item}>{missingLabel(item)}</p>
                  ))}
                </div>
              )}
              <details className="border-t pt-3" key={selected.id}>
                <summary className="w-fit cursor-pointer rounded text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  {label("workbench.recipes.previewTask")}
                </summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  {label("workbench.recipes.previewHint")}
                </p>
                {preview === null ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {label("workbench.recipes.previewMissing")}
                  </p>
                ) : (
                  <pre
                    className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-xs"
                    data-testid="recipe-prompt-preview"
                  >
                    {preview}
                  </pre>
                )}
              </details>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="submit" disabled={busy}>
                  <Play size={14} />
                  {label(busy ? "workbench.recipes.busy" : "workbench.recipes.runOnce")}
                </Button>
                <Button type="button" variant="ghost" onClick={schedule} disabled={busy}>
                  {label("workbench.recipes.scheduleElsewhere")}
                  <ArrowUpRight size={14} />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {label("workbench.recipes.scheduleHint")}
              </p>
            </form>
          </>
        ) : (
          !loading &&
          !listError && (
            <div className="max-w-2xl space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {label("workbench.recipes.emptyHint")}
              </p>
              <div className="divide-y">
                {recipePresets().map((spec) => (
                  <button
                    key={spec.title}
                    type="button"
                    disabled={busy}
                    onClick={() => setEditor({ spec })}
                    className="flex w-full items-start gap-3 py-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <FileText size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="block text-sm font-medium">{spec.title}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {spec.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        )}
      </section>
      {editor && (
        <RecipeEditor
          key={`${editor.id ?? "new"}:${editor.spec.title}`}
          spec={editor.spec}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
