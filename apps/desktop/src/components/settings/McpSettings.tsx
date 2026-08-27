import {
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
  ScrollArea,
  SettingsCard,
  SettingsSection,
  Switch,
  Textarea,
} from "ui";
import { getMcpLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import {
  type DiscoveredMcpServer,
  discoverMcpConfigs,
  isDesktopRuntime,
  pickMcpConfigFile,
} from "../../lib/tauriBridge";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useSidecarStore } from "../../stores/sidecarStore";

const api = createServerApi();

type MCPServer = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
};

type ImportRow = DiscoveredMcpServer & { exists: boolean };

// Session-only health-check state per server row — deliberately not
// persisted anywhere (a probe result is only trustworthy at probe time).
type McpTestRowState =
  | { status: "testing" }
  | { status: "ok"; toolCount: number; toolNames: string[] }
  | { status: "fail"; error: string };

// Transport type is implied by the config shape — no need to ask for it.
// `url`/`httpUrl` ⇒ http (or sse when declared), otherwise stdio.
function inferMcpType(config: Record<string, unknown>): string {
  const declared = typeof config.type === "string" ? config.type.toLowerCase() : "";
  if (declared === "sse") return "sse";
  if (config.url || config.httpUrl || declared === "http" || declared === "remote") {
    return "http";
  }
  return "stdio";
}

export function McpSettings() {
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [, setLoading] = useState(false);

  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpConfig, setMcpConfig] = useState("{\n  \n}");
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<MCPServer | null>(null);
  const [editName, setEditName] = useState("");
  const [editConfig, setEditConfig] = useState("{\n  \n}");
  const [editSaving, setEditSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, McpTestRowState>>({});
  const [testingAll, setTestingAll] = useState(false);
  const sidecarStatus = useSidecarStore((s) => s.status);
  const sidecarReady = sidecarStatus === "ready";

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const { servers } = await api.mcp.listServers();
      setMcpServers((servers || []) as MCPServer[]);
    } catch (error) {
      notifyError("加载失败", error instanceof Error ? error.message : "无法加载 MCP 配置。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(() => {
    const onUp = () => {
      void loadServers();
    };

    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => {
      window.removeEventListener(BACKEND_UP_EVENT, onUp);
    };
  }, [loadServers]);

  const handleCreateMcp = async () => {
    if (!mcpName.trim()) {
      notifyError("配置错误", "请填写 MCP Server 名称。");
      return;
    }

    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(mcpConfig);
    } catch {
      notifyError("配置错误", "MCP config 必须是合法 JSON。");
      return;
    }

    setLoading(true);
    try {
      await api.mcp.createServer({
        name: mcpName.trim(),
        type: inferMcpType(parsedConfig),
        config: parsedConfig,
      });
      setMcpModalOpen(false);
      setMcpName("");
      setMcpConfig("{\n  \n}");
      await loadServers();
      notifySuccess("已创建", "MCP Server 已添加。");
    } catch (error) {
      notifyError("创建失败", error instanceof Error ? error.message : "无法创建 MCP Server。");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteMcp = async (id: string) => {
    setMcpBusyId(id);
    try {
      await api.mcp.deleteServer(id);
      await loadServers();
      notifySuccess("已删除", "MCP Server 已删除。");
    } catch (error) {
      notifyError("删除失败", error instanceof Error ? error.message : "无法删除 MCP Server。");
    } finally {
      setMcpBusyId(null);
    }
  };

  const handleToggleMcp = async (server: MCPServer) => {
    setMcpBusyId(server.id);
    try {
      await api.mcp.updateServer(server.id, { isEnabled: !server.isEnabled });
      await loadServers();
      notifySuccess("已更新", "MCP Server 状态已更新。");
    } catch (error) {
      notifyError(
        "更新失败",
        error instanceof Error ? error.message : "无法更新 MCP Server 状态。",
      );
    } finally {
      setMcpBusyId(null);
    }
  };

  // Health check goes through the sidecar (the real MCP runtime: local
  // PATH / process env), NOT the server's /mcp/servers/:id/test endpoint,
  // which cannot exercise stdio commands from inside a container.
  const handleTestServer = useCallback(async (server: MCPServer) => {
    const client = useSidecarStore.getState().client;
    if (!client) return;
    setTestResults((prev) => ({ ...prev, [server.id]: { status: "testing" } }));
    let next: McpTestRowState;
    try {
      const result = await client.testMcpServer({ name: server.name, config: server.config });
      next = result.ok
        ? {
            status: "ok",
            toolCount: result.toolCount ?? 0,
            toolNames: result.toolNames ?? [],
          }
        : { status: "fail", error: result.error ?? "unknown error" };
    } catch (error) {
      next = {
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    setTestResults((prev) => ({ ...prev, [server.id]: next }));
  }, []);

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      // Parallel on purpose: total wall time ≈ the slowest single probe
      // (bounded by the sidecar's 15s timeout), each row settles on its own.
      await Promise.all(mcpServers.map((server) => handleTestServer(server)));
    } finally {
      setTestingAll(false);
    }
  };

  const openEdit = (server: MCPServer) => {
    setEditTarget(server);
    setEditName(server.name);
    setEditConfig(JSON.stringify(server.config ?? {}, null, 2));
  };

  const handleUpdateMcp = async () => {
    if (!editTarget) return;
    if (!editName.trim()) {
      notifyError("配置错误", "请填写 MCP Server 名称。");
      return;
    }
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(editConfig);
    } catch {
      notifyError("配置错误", "MCP config 必须是合法 JSON。");
      return;
    }
    setEditSaving(true);
    try {
      await api.mcp.updateServer(editTarget.id, {
        name: editName.trim(),
        type: inferMcpType(parsedConfig),
        config: parsedConfig,
      });
      setEditTarget(null);
      await loadServers();
      notifySuccess("已保存", "MCP Server 已更新。");
    } catch (error) {
      notifyError("保存失败", error instanceof Error ? error.message : "无法更新 MCP Server。");
    } finally {
      setEditSaving(false);
    }
  };

  // Default-select every freshly-discovered row whose name isn't already
  // configured, so re-importing duplicates is opt-in rather than automatic.
  const mergeImportRows = useCallback(
    (found: DiscoveredMcpServer[], existingNames: Set<string>) => {
      setImportRows((prev) => {
        const seen = new Set(prev.map((r) => `${r.client} ${r.name}`));
        const additions = found
          .filter((s) => !seen.has(`${s.client} ${s.name}`) && !existingNames.has(s.name))
          .map((s) => ({ ...s, exists: false }));
        const next = [...prev, ...additions];
        setSelectedRows((sel) => {
          const updated = new Set(sel);
          next.forEach((_, idx) => {
            if (idx >= prev.length) updated.add(idx);
          });
          return updated;
        });
        return next;
      });
    },
    [],
  );

  const openImport = async () => {
    setImportOpen(true);
    setImportRows([]);
    setSelectedRows(new Set());
    setDiscovering(true);
    try {
      const found = await discoverMcpConfigs();
      const existingNames = new Set(mcpServers.map((s) => s.name));
      mergeImportRows(found, existingNames);
    } catch (error) {
      notifyError("扫描失败", error instanceof Error ? error.message : "无法扫描本地 MCP 配置。");
    } finally {
      setDiscovering(false);
    }
  };

  const handlePickFile = async () => {
    try {
      const found = await pickMcpConfigFile();
      if (found === null) return; // user cancelled
      if (found.length === 0) {
        notifyError("未发现配置", "所选文件中没有可解析的 MCP server。");
        return;
      }
      const existingNames = new Set(mcpServers.map((s) => s.name));
      mergeImportRows(found, existingNames);
    } catch (error) {
      notifyError("读取失败", error instanceof Error ? error.message : "无法读取所选文件。");
    }
  };

  const toggleRow = (idx: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleImport = async () => {
    // Same tool may be checked under several platform groups — collapse by
    // signature (first selected occurrence wins) so it's created once.
    const seen = new Set<string>();
    const rows = [...selectedRows]
      .sort((a, b) => a - b)
      .map((idx) => importRows[idx])
      .filter(Boolean)
      .filter((row) => {
        if (seen.has(row.signature)) return false;
        seen.add(row.signature);
        return true;
      });
    if (rows.length === 0) {
      notifyError("未选择", "请至少勾选一个要导入的 MCP server。");
      return;
    }
    setImporting(true);
    let ok = 0;
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await api.mcp.createServer({ name: row.name, type: row.type, config: row.config });
        ok += 1;
      } catch {
        failed.push(row.name);
      }
    }
    setImporting(false);
    await loadServers();
    setImportOpen(false);
    if (failed.length === 0) {
      notifySuccess("已导入", `成功导入 ${ok} 个 MCP server。`);
    } else {
      notifyError("部分导入失败", `成功 ${ok} 个，失败 ${failed.length} 个：${failed.join("、")}`);
    }
  };

  // Union of every platform a tool was found in, so we only name sources that
  // actually exist (no CC Switch installed ⇒ not mentioned).
  const discoveredSources = [...new Set(importRows.flatMap((row) => row.clients))];

  const allSelected = importRows.length > 0 && selectedRows.size === importRows.length;
  const toggleSelectAll = () => {
    setSelectedRows(allSelected ? new Set() : new Set(importRows.map((_, idx) => idx)));
  };

  // How many distinct servers a selection will actually create (the same tool
  // picked from a file plus discovery collapses by signature).
  const uniqueSelectedCount = new Set(
    [...selectedRows].map((idx) => importRows[idx]?.signature).filter(Boolean),
  ).size;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="高级工具（MCP）"
        description="MCP 是 Agent 的附加工具层，用于私有数据源、执行器和自定义工作流，不是默认联网能力的前提。"
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleTestAll()}
              disabled={!sidecarReady || testingAll || mcpServers.length === 0}
              title={!sidecarReady ? getMcpLabel("settings.mcp.sidecarNotReady") : undefined}
            >
              {testingAll ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}{" "}
              {testingAll
                ? getMcpLabel("settings.mcp.testingAll")
                : getMcpLabel("settings.mcp.testAll")}
            </Button>
            {isDesktopRuntime() && (
              <Button size="sm" variant="outline" onClick={() => void openImport()}>
                <Download size={16} /> 导入
              </Button>
            )}
            <Button size="sm" onClick={() => setMcpModalOpen(true)}>
              <Plus size={16} /> 添加 MCP
            </Button>
          </div>
        }
      >
        <SettingsCard divided={false} className="p-4">
          {mcpServers.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无 MCP Server 配置。</p>
          ) : (
            <div className="flex flex-col gap-2">
              {mcpServers.map((server) => {
                const testResult = testResults[server.id];
                return (
                  <div
                    key={server.id}
                    className="flex items-center justify-between rounded-xl border border-border/50 bg-background/60 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{server.name}</p>
                      <p className="text-xs text-muted-foreground">{server.type}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {testResult?.status === "testing" && (
                        <Loader2 size={16} className="animate-spin text-muted-foreground" />
                      )}
                      {testResult?.status === "ok" && (
                        <span
                          className="flex items-center gap-1 text-xs text-emerald-600"
                          title={testResult.toolNames.join("\n")}
                        >
                          <CheckCircle2 size={14} className="shrink-0" />
                          {getMcpLabel("settings.mcp.toolCount").replace(
                            "{count}",
                            String(testResult.toolCount),
                          )}
                        </span>
                      )}
                      {testResult?.status === "fail" && (
                        <span
                          className="flex max-w-[260px] items-center gap-1 text-xs text-destructive"
                          title={testResult.error}
                        >
                          <XCircle size={14} className="shrink-0" />
                          <span className="truncate">{testResult.error}</span>
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleTestServer(server)}
                        disabled={!sidecarReady || testResult?.status === "testing"}
                        title={
                          !sidecarReady ? getMcpLabel("settings.mcp.sidecarNotReady") : undefined
                        }
                      >
                        {getMcpLabel("settings.mcp.test")}
                      </Button>
                      <Switch
                        checked={server.isEnabled}
                        onCheckedChange={() => void handleToggleMcp(server)}
                        disabled={mcpBusyId === server.id}
                      />
                      <div className="flex items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(server)}
                          disabled={mcpBusyId === server.id}
                          title="修改"
                        >
                          <Pencil size={18} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          onClick={() => void handleDeleteMcp(server.id)}
                          disabled={mcpBusyId === server.id}
                          title="删除"
                        >
                          <Trash2 size={18} />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <Dialog open={mcpModalOpen} onOpenChange={setMcpModalOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>添加 MCP Server</DialogTitle>
            <DialogDescription className="sr-only">
              填写名称、类型和 JSON 配置，创建一个新的 MCP Server。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>名称</Label>
              <Input value={mcpName} onChange={(event) => setMcpName(event.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>配置 JSON</Label>
              <Textarea
                rows={12}
                className="font-mono text-sm"
                value={mcpConfig}
                onChange={(event) => setMcpConfig(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setMcpModalOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateMcp()}>创建</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>修改 MCP Server</DialogTitle>
            <DialogDescription className="sr-only">
              修改该 MCP Server 的名称与 JSON 配置。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>名称</Label>
              <Input value={editName} onChange={(event) => setEditName(event.target.value)} />
            </div>

            <div className="grid gap-1.5">
              <Label>配置 JSON</Label>
              <Textarea
                rows={12}
                className="font-mono text-sm"
                value={editConfig}
                onChange={(event) => setEditConfig(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void handleUpdateMcp()} disabled={editSaving}>
              {editSaving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>导入已有 MCP 配置</DialogTitle>
            <DialogDescription>
              {discoveredSources.length > 0
                ? "已扫描本地 AI 工具的 MCP 配置；同一工具合并为一条，仅列出尚未导入的。勾选要导入的 server，或手动选择配置文件。"
                : "勾选要导入的 server，或手动选择一个配置文件导入。"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => void handlePickFile()}>
              <FileUp size={16} /> 选择配置文件…
            </Button>
            {importRows.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  已选 {selectedRows.size} / {importRows.length}
                </span>
                <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                  {allSelected ? "取消全选" : "全选"}
                </Button>
              </div>
            )}
          </div>

          <ScrollArea className="max-h-[320px] rounded-xl border border-border/50">
            {discovering ? (
              <p className="p-4 text-sm text-muted-foreground">正在扫描本地配置…</p>
            ) : importRows.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                未发现可导入的 MCP 配置。可点击上方「选择配置文件…」手动导入。
              </p>
            ) : (
              <div className="flex flex-col gap-1 p-2">
                {importRows.map((row, idx) => {
                  const meta = [row.type !== "stdio" ? row.type : null, row.description]
                    .filter(Boolean)
                    .join(" · ");
                  // Wrapping the control makes the whole row clickable, but a
                  // screen reader still needs the pairing spelled out — without
                  // it the checkbox announces itself with no name at all.
                  const checkboxId = `mcp-import-row-${idx}`;
                  return (
                    <label
                      // biome-ignore lint/suspicious/noArrayIndexKey: index only disambiguates rows that are identical in name and signature
                      key={`${row.name}-${row.signature}-${idx}`}
                      htmlFor={checkboxId}
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
                    >
                      <Checkbox
                        id={checkboxId}
                        className="mt-0.5"
                        checked={selectedRows.has(idx)}
                        onCheckedChange={() => toggleRow(idx)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{row.name}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1">
                          {row.clients.map((c) => (
                            <span
                              key={c}
                              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {c}
                            </span>
                          ))}
                          {meta && <span className="text-xs text-muted-foreground">· {meta}</span>}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void handleImport()}
              disabled={importing || selectedRows.size === 0}
            >
              {importing ? "导入中…" : `导入所选（${uniqueSelectedCount}）`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
