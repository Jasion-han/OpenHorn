import { useCallback, useEffect, useState } from "react";
import {
  type CredentialSource,
  listCredentialSources,
  testCredentialSource,
} from "../../lib/credentialApi";
import { createServerApi } from "../../lib/serverApi";

const STATUS_ICONS: Record<string, string> = {
  available: "✅",
  expired: "⚠️",
  error: "❌",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

const API_KEY_LINKS: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/apikey",
};

export function DesktopCredentialSourcesPanel() {
  const [sources, setSources] = useState<CredentialSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; error?: string }>
  >({});
  const [existingCliSourceIds, setExistingCliSourceIds] = useState<Set<string>>(new Set());

  const scan = useCallback(async () => {
    setLoading(true);
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
    } finally {
      setLoading(false);
    }
  }, []);

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
        <h3 className="text-lg font-semibold">认证来源</h3>
        <button
          type="button"
          onClick={scan}
          disabled={loading}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          {loading ? "扫描中..." : "🔄 重新扫描"}
        </button>
      </div>

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        自动检测本地环境变量和 AI 工具登录状态。环境变量中的 API Key 可直接用于创建渠道。
      </p>

      {sources.length === 0 && !loading && (
        <div className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          未检测到任何认证来源。可通过设置环境变量（OPENAI_API_KEY、ANTHROPIC_API_KEY、GEMINI_API_KEY）或登录 AI CLI 工具来添加。
        </div>
      )}

      {envSources.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            环境变量（可直接用于创建渠道）
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
                    <span className={`text-xs ${testResult.success ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                      {testResult.success ? "✓ 可用" : testResult.error || "失败"}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTest(source.id)}
                    disabled={testing === source.id}
                    className="rounded-md bg-neutral-100 px-2 py-1 text-xs hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 disabled:opacity-50"
                  >
                    {testing === source.id ? "测试中..." : "测试"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {cliSources.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
            CLI 已登录（通过 CLI 子进程模式直接使用）
          </h4>
          {cliSources.map((source) => {
            const creating = testing === `create-${source.id}`;
            const alreadyCreated = existingCliSourceIds.has(source.id) || testResults[`create-${source.id}`]?.success;
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
                    <button
                      type="button"
                      disabled={creating}
                      className="rounded-md bg-blue-500 px-2.5 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
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
                            baseUrl: source.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
                          });
                          setTestResults((prev) => ({ ...prev, [`create-${source.id}`]: { success: true } }));
                        } catch (err) {
                          setTestResults((prev) => ({
                            ...prev,
                            [`create-${source.id}`]: { success: false, error: err instanceof Error ? err.message : "创建失败" },
                          }));
                        } finally {
                          setTesting(null);
                        }
                      }}
                    >
                      {creating ? "创建中..." : "一键创建渠道"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
