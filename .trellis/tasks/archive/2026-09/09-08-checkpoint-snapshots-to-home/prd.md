# 回滚快照迁出项目目录到用户目录

## 现状
sidecar `checkpoints.ts` 把每个 agent 回合的文件备份写到 `<workspaceRoot>/.openhorn/snapshots/<runId>/`，
并往用户仓库的 `.gitignore` 追加 `.openhorn/`。问题：污染用户仓库；改用户 `.gitignore` 本身是侵入；
回合开始就建目录、没改文件也留空壳；只增不减无清理。

成熟工具的惯例（Claude Code `~/.claude/file-history/<session>`、Codex `~/.codex/`）：运行时状态放用户目录、
按项目路径分桶，项目里只放用户手写配置。

## 目标
1. 快照根目录改为 `~/.openhorn/snapshots/<workspaceSlug>/<runId>/`，`workspaceSlug` = 规范化绝对路径把
   路径分隔符替换为 `-`（同 Claude Code 的 `-Users-han-Project-OpenHorn` 风格），Windows 盘符 `:` 去掉。
2. 删除对用户 `.gitignore` 的任何写入。
3. 回合结束时没有备份任何文件 → 删除该 runId 目录（不留空壳）。
4. 保留策略：每个 workspace 只保留最近 20 个快照目录（按目录 mtime），新建时清理更早的。
5. 兼容：`createCheckpointSession` 时若 `<workspaceRoot>/.openhorn/snapshots` 存在，把其中的 runId 目录
   整体移到新位置（同名不覆盖，跳过），移完删空的 `<workspaceRoot>/.openhorn/snapshots`；`.openhorn/` 下若还有
   其它内容（skills 物化）不动。
6. `rollbackCheckpoint(workspaceRoot, runId)` 改到新位置查找；`ownedRunIds` 校验不变。
7. 快照根可通过 `OPENHORN_HOME` 环境变量覆盖（默认 `os.homedir()/.openhorn`），测试用。

## 不做
- Rust 侧 `skills_materialize_*` 里的 `.openhorn` 逻辑（桌面端已无调用者，另议）。
- `fs.ts` 的 `.openhorn` 隐藏过滤保留（兼容旧目录）。

## 验收
- sidecar `bun test` 绿；新增测试：slug 计算、空快照删除、保留 20 个、旧目录迁移、rollback 走新路径、
  不再写 `.gitignore`。
- 重新编译 sidecar（`compile:tauri:host`），真机在 Vorla 项目跑一回合：`~/.openhorn/snapshots/-Users-han-Project-Vorla/`
  出现目录，`/Users/han/Project/Vorla/.openhorn/snapshots` 被迁走。
- 文档：`skills/openhorn/rules/sidecar-security.md` 与 `references/architecture.md` 更新快照位置。
