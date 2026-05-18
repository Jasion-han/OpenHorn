import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "ui";
import {
  type CredentialSource,
  listCredentialSources,
  testCredentialSource,
} from "../../lib/credentialApi";
import { getCredentialLabel } from "../../lib/i18n/agent";
import { createServerApi } from "../../lib/serverApi";
import type { DetectedCredential } from "../../lib/sidecarClient";
import { useSidecarStore } from "../../stores/sidecarStore";

const STATUS_ICONS: Record<string, string> = {
  available: "✅",
  expired: "⚠️",
  error: "❌",
  not_detected: "⬜",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

const SOURCE_LABELS: Record<string, string> = {
  codex_cli: "Codex CLI (ChatGPT Plus)",
  claude_code: "Claude Code",
  gemini_cli: "Gemini CLI",
  env_var: "环境变量",
};

function getStatusLabel(status: string): string {
  switch (status) {
    case "available":
      return getCredentialLabel("settings.credentialSources.available");
    case "expired":
      return getCredentialLabel("settings.credentialSources.expired");
    default:
      return getCredentialLabel("settings.credentialSources.notDetected");
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case "available":
      return "text-green-600 dark:text-green-400";
    case "expired":
      return "text-orange-600 dark:text-orange-400";
    default:
      return "text-neutral-500 dark:text-neutral-400";
  }
}

export function DesktopCredentialSourcesPanel() {
  const [sources, setSources] = useState<CredentialSource[]>([]);
  const [sidecarCredentials, setSidecarCredentials] = useState<DetectedCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [sidecarScanError, setSidecarScanError] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; error?: string }>
  >({});
  const [existingCliSourceIds, setExistingCliSourceIds] = useState<Set<string>>(new Set());

  const sidecarStatus = useSidecarStore((state) => state.status);
  const sidecarClient = useSidecarStore((state) => state.client);

  const scan = useCallback(async () => {
    setLoading(true);
    setSidecarScanError(false);
    try {
      const [result, { channels }] = await Promise.all([
        listCredentialSources(),
        createServerApi().channels.list(),
      ]);
      setSources(result);
      const channelNames = new Set(channels.map((ch) => ch.name));
      const cliIds = new Set<string>();
      for (const s of result) {
        if (s.sourceType === "cli_oauth" && channelNames.has(s.sourceName)) {
          cliIds.add(s.id);
        }
      }
      setExistingCliSourceIds(cliIds);
    } catch {
      setSources([]);
    }

    // Scan sidecar-detected credentials
    if (sidecarClient && sidecarStatus === "ready") {
      try {
        const detected = await sidecarClient.detectCredentials();
        setSidecarCredentials(detected);
      } catch {
        setSidecarCredentials([]);
        setSidecarScanError(true);
      }
    } else {
      setSidecarCredentials([]);
    }

    setLoading(false);
  }, [sidecarClient, sidecarStatus]);

  useEffect(() => {
    scan();
  }, [scan]);

  const handleTest = async (sourceId: string) => {
    setTesting(sourceId);
    try {
      const result = await testCredentialSource(sourceId);
      setTestResults((prev) => ({ ...prev, [sourceId]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [sourceId]: {
          success: false,
          error: err instanceof Error ? err.message : "测试失败",
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  const envSources = sources.filter((s) => s.sourceType === "env_var");
  const cliSources = sources.filter((s) => s.sourceType === "cli_oauth");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {getCredentialLabel("settings.credentialSources")}
        </h3>
        <Button variant="outline" size="sm" onClick={scan} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          <span>
            {loading
              ? getCredentialLabel("settings.credentialSources.scanning")
              : getCredentialLabel("settings.credentialSources.refreshScan")}
          </span>
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        {getCredentialLabel("settings.credentialSources.description")}
      </p>

      {/* Sidecar-detected credentials */}
      {sidecarStatus === "ready" && sidecarCredentials.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            Sidecar {getCredentialLabel("settings.credentialSources.detected")}
          </h4>
          {sidecarCredentials.map((cred) => {
            const key = `${cred.provider}-${cred.source}`;
            const isExpired = cred.expiresAt && new Date(cred.expiresAt).getTime() < Date.now();
            const status = isExpired ? "expired" : "available";
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{STATUS_ICONS[status]}</span>
                  <div>
                    <div className="text-sm font-medium">
                      {SOURCE_LABELS[cred.source] || cred.source}
                    </div>
                    <div className="flex gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                        {cred.type === "oauth_token" ? "OAuth" : "API Key"}
                      </span>
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        {PROVIDER_LABELS[cred.provider] || cred.provider}
                      </span>
                      {cred.email && (
                        <span className="text-neutral-400 dark:text-neutral-500">{cred.email}</span>
                      )}
                    </div>
                  </div>
                </div>
                <span className={cn("text-xs font-medium", getStatusColor(status))}>
                  {getStatusLabel(status)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {sidecarStatus !== "ready" && (
        <div className="rounded-lg border border-neutral-200 p-3 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          Sidecar 未就绪，无法扫描本地认证
        </div>
      )}

      {sidecarStatus === "ready" && sidecarScanError && (
        <div className="rounded-lg border border-orange-200 p-3 text-sm text-orange-600 dark:border-orange-700 dark:text-orange-400">
          {getCredentialLabel("settings.credentialSources.scanFailed")}
        </div>
      )}

      {/* Server-side env var sources */}
      {envSources.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            {getCredentialLabel("settings.credentialSources.envVar")}
          </h4>
          {envSources.map((source) => {
            const testResult = testResults[source.id];
            return (
              <div
                key={source.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{STATUS_ICONS[source.status] || "⬜"}</span>
                  <div>
                    <div className="text-sm font-medium font-mono">{source.sourceName}</div>
                    <div className="flex gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                        API Key
                      </span>
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        {PROVIDER_LABELS[source.provider] || source.provider}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {testResult && (
                    <span
                      className={`text-xs ${testResult.success ? "text-green-600 dark:text-green-400" : "text-red-500"}`}
                    >
                      {testResult.success
                        ? `✓ ${getCredentialLabel("settings.credentialSources.available")}`
                        : testResult.error || "失败"}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(source.id)}
                    disabled={testing === source.id}
                  >
                    {testing === source.id ? "测试中..." : "测试"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CLI OAuth sources */}
      {cliSources.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-neutral-600 dark:text-neutral-300">CLI 已登录</h4>
          {cliSources.map((source) => {
            const creating = testing === `create-${source.id}`;
            const alreadyCreated =
              existingCliSourceIds.has(source.id) || testResults[`create-${source.id}`]?.success;
            return (
              <div
                key={source.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{STATUS_ICONS[source.status] || "⬜"}</span>
                  <div>
                    <div className="text-sm font-medium">{source.sourceName}</div>
                    <div className="flex gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <span className="rounded bg-green-50 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                        CLI 已登录
                      </span>
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                        {PROVIDER_LABELS[source.provider] || source.provider}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!alreadyCreated && testResults[`create-${source.id}`]?.success === false && (
                    <span className="text-xs text-red-500">
                      {testResults[`create-${source.id}`].error}
                    </span>
                  )}
                  {alreadyCreated ? (
                    <span className="rounded-md bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      渠道已创建
                    </span>
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={creating}
                      onClick={async () => {
                        setTesting(`create-${source.id}`);
                        try {
                          const api = createServerApi();
                          const protocol = source.provider === "anthropic" ? "anthropic" : "openai";
                          await api.channels.create({
                            name: source.sourceName,
                            provider: source.provider,
                            protocol,
                            apiKey: `__cli_oauth__:${source.id}`,
                            baseUrl:
                              source.provider === "anthropic"
                                ? "https://api.anthropic.com"
                                : "https://api.openai.com/v1",
                          });
                          setTestResults((prev) => ({
                            ...prev,
                            [`create-${source.id}`]: { success: true },
                          }));
                        } catch (err) {
                          setTestResults((prev) => ({
                            ...prev,
                            [`create-${source.id}`]: {
                              success: false,
                              error: err instanceof Error ? err.message : "创建失败",
                            },
                          }));
                        } finally {
                          setTesting(null);
                        }
                      }}
                    >
                      {creating ? "创建中..." : "一键创建渠道"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {sources.length === 0 && sidecarCredentials.length === 0 && !loading && (
        <div className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          未检测到任何认证来源。可通过设置环境变量（OPENAI_API_KEY、ANTHROPIC_API_KEY、GEMINI_API_KEY）或登录
          AI CLI 工具来添加。
        </div>
      )}
    </div>
  );
}
