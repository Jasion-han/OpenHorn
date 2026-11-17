# 文件、缓存与配置路由检查

本轮继续检查失败重试、缓存过期、重复请求和数据回收，确认并修复五类问题。测试使用合成请求、独立数据库和临时文件；未删除真实历史记录、上传真实文件或调用真实模型。

| 发现 / 程度 | 修复前影响 | 修复后行为与验证路径 |
|---|---|---|
| 导入历史并发 / 中 | 旧分页可追加到新列表并覆盖游标；删除后旧读取可恢复已删除卡片；追加MCP配置会原地修改之前的扫描快照 | 列表请求与删除版本校验；重复删除等待锁；追加使用独立数组。页面增加加载重试和删除范围确认。[生命周期测试](../apps/desktop/src/stores/importStore.lifecycle.test.ts) → [importStore](../apps/desktop/src/stores/importStore.ts) → ImportSettings |
| 附件上传失败 / 中 | 文件已写入但数据库插入被拒绝时，遗留无记录的文件 | 独占创建本次文件；插入失败后确认无记录才清理，保留原有文件。数据库已提交但确认丢失时保留文件；无法读取确认状态时也保留，避免误删。[隔离子进程测试](../apps/server/src/services/attachmentService.failure.test.ts) → [attachmentService](../apps/server/src/services/attachmentService.ts) |
| embedding凭据路由 / 中 | 没有OpenAI兼容渠道时会选其他协议；第一个兼容渠道是CLI OAuth时又会提前放弃后续有效API Key | 只选择启用、属于当前用户的OpenAI兼容协议API Key；跳过CLI OAuth后继续查找。验证仅使用合成密钥，不请求embedding端点 |
| MCP特殊名称 / 低 | `__proto__` 名称被普通对象设置器处理，导致启用配置从工具列表丢失 | 使用无原型键表，验证名称是自有键且JSON往返保留。[映射测试](../apps/desktop/src/lib/sidecarRunSupport.mcp.test.ts) → resolveEnabledMcpServers。未将此问题描述为已证实的远程漏洞 |
| 外部编辑器检测 / 中 | 失败结果永久缓存，安装/恢复编辑器后也需重启才能识别 | 并发检测共享请求；成功结果缓存30秒，失败可重试；显式重扫绕过缓存，失败保留上次成功列表和选择。页面提供重新检测按钮与错误反馈。[检测回归](../apps/desktop/src/stores/externalEditorStore.test.ts) → externalEditorStore → GeneralSettings |

## 验证结果

- 修复前[桌面证据](audits/2026-11-09/lifecycle/desktop-before.log)中5项失败；[服务端证据](audits/2026-11-09/lifecycle/server-before.log)中附件残留和协议选择两项失败。另补正常上传与数据库确认丢失的保护回归，确保文件不会被修复逻辑误删。
- Server469、Desktop663、Sidecar331、Shared53，共 **1,516项通过、0失败**。
- 设置/导入/编辑器16、工作台25、聊天异常56个浏览器检查点通过，共97项；页面行为包含历史加载失败恢复、旧分页隔离、删除失败保留/重试、旧读取防复活及编辑器失败重扫。
- 全仓类型/格式与macOS debug app打包通过。本地服务和桌面已重启；实际重新检测编辑器后只查看选项，删除历史确认窗口实际打开并取消，没有改变选择或删除记录。
- 真实数据仍为344个会话、2条定时任务、0条启用。证据汇总见[results.json](audits/2026-11-09/lifecycle/results.json)，文件校验见[sha256.json](audits/2026-11-09/lifecycle/sha256.json)。

复查定向行为：

```bash
pnpm --filter desktop exec bun test src/stores/importStore.lifecycle.test.ts src/stores/externalEditorStore.test.ts src/lib/sidecarRunSupport.mcp.test.ts
OPENHORN_TEST_DATABASE_URL=file:/tmp/openhorn-lifecycle-review.db pnpm --filter server exec bun test src/services/attachmentService.failure.test.ts
node apps/desktop/scripts/settings-clarity.browser.mjs
pnpm typecheck
pnpm check
```

附件测试会启动自有临时目录/数据库的子进程，使用合成加密密钥并在结束后清理临时目录。后台任务恢复继续使用已有租约和保存恢复逻辑，本轮相关完整套件通过，未改执行状态机。embedding检查仅确认渠道/凭据选择，兼容协议不等于目标端点一定支持当前embedding模型；数据库状态不明时保留文件的策略也不等于完整垃圾回收系统。

本轮未Git提交、推送或外部部署；完整本机日志位于`/tmp/openhorn-lifecycle-*.log`。
