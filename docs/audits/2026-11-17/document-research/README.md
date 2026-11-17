# PDF 图文输入与深度研究验收

本轮完成了两项后续能力：本地 PDF 选页图文输入，以及沿用当前搜索源的有界深度研究。

- PDF 默认仍走文字提取；用户显式勾选“读取 PDF 图表”并填写页码后，PDF.js 在本地将页面渲染为 JPEG。
- 每次最多 6 页、单图 1 MiB、合计 6 MiB；非视觉模型拒绝发送图像；Agent 页面输入按账户写入 IndexedDB，最多保留 7 天，缺失时要求重新附加。
- 深度研究通过 `/research` 入口发起，只接受 OpenAI、Anthropic、Google API 渠道；只提供 Search/Fetch，最多 4 个唯一搜索请求、6 个页面读取任务、12 轮工具决策，总时限 180 秒。
- 报告来源必须来自结构化搜索/网页读取结果；搜索摘要和原文读取分别标记，模型正文添加的来源会导致研究失败。
- 研究不挂载 MCP、Skills、Shell 或 SDK resume；不自动切换搜索源，不自动重试付费请求；每次重试重新读取当前激活搜索连接。
- 文件上传改用有界 `busboy` 解析，修复实际复现的 Bun `formData()` 二进制 NUL 截断和同名文件只保留最后一项问题；客户端核对回执数量、名称、大小和 ID。

## 证据

- 浏览器验证：[`browser-results.json`](./browser/browser-results.json)。4 组通过，0 页面错误，0 非预期网络请求；实际生成图形页像素 184792，选中第 2 页。
- 浏览器截图：[`01-research-menu-focus.png`](./browser/01-research-menu-focus.png)、[`02-selected-document-page.png`](./browser/02-selected-document-page.png)。
- 原生桌面截图：[`01-mode-menu.png`](./native/01-mode-menu.png)。真实打开最终 OpenHorn 桌面包后看到 Chat、Agent、深度研究三个浅色菜单项及研究说明。
- 真实产品环境重启：保留原 `data/openhorn.db`、原加密环境和当前 Tavily/OpenRouter 状态；后端换成新代码后，未授权 JSON 上传返回结构化 `invalid_attachment_multipart`，说明新上传解析器已运行。

## 验证命令

- Shared 134 / 0
- Adapters 100 / 0
- Desktop 764 / 0
- Sidecar 403 / 0
- Server 653 / 0
- 合计 2054 / 0
- 类型检查：通过
- Biome：974 文件通过
- Sidecar host 编译：通过
- Tauri debug `.app` 构建：通过
- Chat 浏览器回归：通过
- 文档浏览器回归：通过
- OpenAI / Anthropic / Google 研究适配器受控协议回归：3 / 0

真实 DeepSeek Files API、真实付费 OCR、真实付费搜索质量和研究报告质量没有在本轮调用；外部能力仍需后续配置对应官方凭据后单独做小样本验收。
