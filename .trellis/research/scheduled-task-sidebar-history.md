# 定时任务侧栏与执行记录

## 2026-11-04 用户确认的交互

- 左侧任务分组只显示启用的任务；关闭立即隐藏，重新开启立即恢复。启用但尚未执行过的任务也显示分组。
- 任务卡片的三个点菜单提供「执行记录」，仅查看该任务的历史，关闭的任务也可查看。可通过「查看全部记录」清除任务筛选。

## 已验证实现与边界

- `DesktopLeftSidebar.tsx` 根据 `scheduledTaskStore.tasks` 的 `enabled` 建立分组，再附加全局近期 runs；不能只按 runs 建组，否则无法判断任务开关。
- `desktopShellStore.scheduledTaskRunsTaskId` 保存非持久化的历史筛选；`openScheduledTasks` 的普通入口清除筛选。
- 单任务历史使用既有 `GET /scheduled-tasks/:id/runs`，结果单独保存在 `taskRuns`，不覆盖后台任务使用的全局 `runs`。全局接口和单任务接口目前默认各返回最近 50 条，不能在全局 50 条上筛选来代替单任务查询。
- 验证：桌面端 `tsc --noEmit`、594 项 Bun 测试、全仓 `pnpm check` 通过。Chrome 中用真实组件与模拟接口验证开关联动、无历史任务、关闭任务的历史、任务切换、查看全部和空记录。未执行真实定时任务。
