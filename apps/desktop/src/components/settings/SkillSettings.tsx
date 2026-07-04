import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, SettingsCard, SettingsSection, Switch } from "ui";
import { notifyError } from "../../lib/notify";
import {
  type DiscoveredSkill,
  discoverSkills,
  skillsDisabledList,
  skillsSetEnabled,
} from "../../lib/tauriBridge";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";

/**
 * Folder-driven Agent Skills. Skills are directories (SKILL.md + scripts) on
 * disk — OpenHorn discovers them from the common AI-CLI locations (CC Switch,
 * Claude Code, Codex, Gemini). This screen lists what was found and lets the user
 * enable/disable each; the enabled set is persisted to a JSON file, and enabled
 * skills are read in place at run time (no copy into the workspace).
 */
export function SkillSettings() {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [discovered, disabledList] = await Promise.all([
        discoverSkills(),
        skillsDisabledList(),
      ]);
      setSkills(discovered ?? []);
      setDisabled(new Set((disabledList ?? []).map((n) => n.trim().toLowerCase())));
    } catch (error) {
      notifyError("加载失败", error instanceof Error ? error.message : "无法扫描技能文件夹。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUp = () => void load();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => window.removeEventListener(BACKEND_UP_EVENT, onUp);
  }, [load]);

  const handleToggle = async (skill: DiscoveredSkill) => {
    const key = skill.name.trim().toLowerCase();
    const currentlyEnabled = !disabled.has(key);
    setBusyName(skill.name);
    try {
      await skillsSetEnabled(skill.name, !currentlyEnabled);
      setDisabled((prev) => {
        const next = new Set(prev);
        if (currentlyEnabled) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch (error) {
      notifyError("更新失败", error instanceof Error ? error.message : "无法更新技能状态。");
    } finally {
      setBusyName(null);
    }
  };

  const enabledCount = skills.filter((s) => !disabled.has(s.name.trim().toLowerCase())).length;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="技能（Agent Skills）"
        description="技能是磁盘上的文件夹（含 SKILL.md 与脚本）。OpenHorn 自动发现你机器上已安装的技能目录。开启的技能在 Agent 运行时按原地路径直接读取，无需拷贝，模型按需读取并执行其中的脚本。"
        action={
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} /> 重新扫描
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">正在扫描技能文件夹…</p>
          ) : skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              未发现任何技能文件夹。把技能目录放到本机常见的技能目录下（或用你的技能管理工具同步），然后点「重新扫描」。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="mb-1 text-xs text-muted-foreground">
                共发现 {skills.length} 个技能，已开启 {enabledCount} 个。
              </p>
              <div className="flex flex-col gap-2">
                {skills.map((skill) => {
                  const enabled = !disabled.has(skill.name.trim().toLowerCase());
                  return (
                    <div
                      key={skill.path}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{skill.name}</p>
                        {skill.description ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {skill.description}
                          </p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {skill.clients.map((c) => (
                            <span
                              key={c}
                              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => void handleToggle(skill)}
                        disabled={busyName === skill.name}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
