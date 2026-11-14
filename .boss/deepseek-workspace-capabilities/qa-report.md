# 质量验收

状态：DONE。此报告记录实现阶段的本地验证，没有真实付费 API 调用。提交范围隔离后的验收另见 docs/2026-11-14_deepseek-shipping-results.md；真实桌面操作将在推送后单独记录。

## 结果

| 门禁 | 结果 |
|---|---|
| shared + adapters Bun | 171通过 / 0失败 |
| server Bun，唯一临时 SQLite、合成 key、外网隔离 | 576通过 / 0失败 |
| desktop Bun | 698通过 / 0失败 |
| sidecar Bun | 342通过 / 0失败 |
| 原有向量存储并发回归，连续10轮 | 30通过 / 0失败 |
| 设置/引用/OCR 浏览器 | 6组通过 |
| 资料库真实菜单与确认流程 | 19项通过 |
| 实际 Chat 发送/停止/重试/编辑/拒答/刷新浏览器 | 58组通过 |
| TypeScript / Biome / diff空白检查 | 通过 |
| 桌面 UI production build / Sidecar host compile | 通过 |
| workspace 锁文件离线冻结校验 | 通过 |

独立复核的5项问题均已关闭：大签名与展示数据拆分、prepared completion 快照保护、拒答重试不恢复旧正文、普通 OpenAI 拒答撤回、预算前过滤不匹配 state。

全量验证还复现并修复同目录独立向量实例的初始化竞争；共享待完成初始化，不覆盖已有表，失败后仍可重新初始化。没有放宽或跳过原有并发断言。

## 证据与范围

- [完整交付说明](../../docs/2026-11-14_deepseek-capabilities-results.md)
- [机器可读验证结果](../../docs/audits/2026-11-14/deepseek/validation.json)
- 浏览器使用真实 React 组件和字典，检查展开、悬停、选中及键盘聚焦，控件沿用浅黄/浅暖灰。
- API 使用合成响应；真实 API 质量、延迟、账户权限和费用未实测。
- 浏览器验收与 host binary 编译不等同完整 Tauri 原生端到端验收。
- 旧客户端省略 Chat saveToken 的兼容入口仍保留，但没有新的快照保护。
- 语音及 Files API 图文混排按既定范围后置。
