# Fix Bug Workflow

## Read First

1. `rules/project-rules.md`
2. `rules/coding-standards.md`
3. 任务相关的 `rules/*.md`（如桌面端 bug 读 `rules/desktop-rules.md`，sidecar 读 `rules/sidecar-security.md`）
4. `references/gotchas.md`

## Steps

1. 复述 bug 范围和受影响的行为
2. 读最少必要的文件——不要读与 symptom 无关的文件
3. 找到 root cause——不是第一个看起来合理的原因，是真正的原因
4. 实现最小正确修复——不做"顺手"清理
5. 验证行为：
   - `pnpm --filter <workspace> exec tsc --noEmit` 类型检查
   - `pnpm --filter <workspace> exec bun test` 跑测试，基线全绿，**必须 0 fail**
   - 如有 UI 影响，自己截图或实际操作验证后再交付，不要盲改让用户人肉回归
6. 如果改了 sidecar 代码，执行 `pnpm --filter sidecar run compile:tauri:host`
7. 如果改了数据库 schema，确认 `bootstrap.ts` 和 `packages/db/src/schema/index.ts` 同步

## Completion Checklist

- [ ] Root cause 已识别（不只是看起来合理的修复）
- [ ] 代码修复已验证（类型检查通过，测试通过）
- [ ] 如改了 sidecar → 重新编译
- [ ] 如改了 DB schema → 两处同步
- [ ] `pnpm check` 通过
