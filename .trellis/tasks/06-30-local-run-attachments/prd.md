# 本地运行附件支持：所有模型读取图片与文件

## Goal
桌面端「Agent 模式 = 本地运行」走 sidecar `agent.run`，目前只发纯文本 prompt、**丢弃附件**（提示「本地运行暂不支持附件」）。目标：让**所有接入的模型/协议**在本地运行下都能读取并解析**图片**与**文件**附件。

## 用户决策
1. PDF/范围由实现方定：前端 pdf.js 抽 PDF 文本 → 与文本文件一样注入（所有模型通用）。
2. **非视觉模型收到图片 → 降级为文本提示**（如 `[图片附件：当前模型不支持视觉，已忽略图片内容]`），不直接发图给非视觉模型报错。
3. 合理分阶段。

## 研究结论（来自两轮全量排查）

### Provider 协议层（packages/adapters/src/adapters.ts）
- 仅 3 个实现：`openai`（含 deepseek/qwen/kimi/glm/doubao/minimax/openrouter 全部兼容厂商）、`anthropic`、`google`。
- chat/chatStream 三协议**已支持图片**：openai `image_url`(`:435,523`)、anthropic `image.source.base64`(`:1108,1210`)、google `inlineData`(`:1488`)。共享 `ChatContentPart`=`text|image`(`:1-3`)。
- **缺口**：Agent 工具调用路径 `runToolCallingTurn(Stream)` 三协议**都不支持图片**，根因 `GenericAgentConversationMessage.content` 只接受 `string`（types.ts:22-38）。仅 Claude SDK 模式能读图(agentService.ts:411)。
- 文件：无原生文件输入；统一 pdf-parse/utf8 抽文本注入 text part（attachmentParser.ts:4-23, messageService.ts:803-834）。与协议无关。
- 无 vision 能力探测（仅废弃的 scoreVisionModelId 启发式，channelService.ts:1155）。

### Sidecar runtime 层
- `agent.run` dispatch（index.ts:350）：codex_cli→`runCodexAgent`(codex.ts:93)；anthropic→`runClaudeAgent`(claude.ts:150)；else→`runDirectAgent`(direct.ts:587)。无 google agent 路径（落 direct）。
- 协议 schema `AgentRunParamsSchema`(protocol.ts:64-78)：`prompt:string`，**无附件字段**；`conversationHistory.content:string`（历史多模态丢失）。
- **Claude**(claude-agent-sdk 0.2.71)：`query({prompt})` 的 prompt 可为 `string | AsyncIterable<SDKUserMessage>`(sdk.d.ts:1459)；`MessageParam.content` 支持 `ImageBlockParam`/`DocumentBlockParam`。改成 async-iterable 注入。**低-中难度**。
- **Direct**(pi-agent-core/pi-ai 0.74)：`agent.prompt(input, images?: ImageContent[])`(agent.d.ts:103)；`ImageContent={type:"image",data:base64,mimeType}`。阻断点：`buildModel` 写死 `input:["text"]`(direct.ts:562,576)，需改 `["text","image"]`。**中难度**。
- **Codex**(子进程，外部二进制)：`turn/start` input 数组(codex.ts:271)，图片 input-item 字段依赖 codex 版本、不可在仓库验证。**高难度/不确定**。RunCodexAgentInput 连 conversationHistory 都没透传。

### Tauri/前端读文件
- 无 Tauri fs 命令、无 fs 插件。**但不需要**：附件已是浏览器 `File[]`，前端 `file.arrayBuffer()`→base64 / `file.text()` 直接读（DesktopChatArea.tsx:1118 已用 objectURL）。PDF 用前端 pdf.js。

## Technical Approach（统一设计）
1. **归一化** `AttachmentPart`（建议放 packages/shared）：`{kind:"image", mediaType, dataBase64}` | `{kind:"file", fileName, mediaType, text}`。
2. **前端解析**（DesktopChatArea 本地路径）：image/*→base64；text/code/json→`file.text()`；pdf→pdf.js 抽文本；其它→file part 注明不支持。删 `:1185-1190` 的忽略附件 warning。
3. **协议**：`AgentRunParamsSchema` += `attachments: AttachmentPart[]`。
4. **透传**：sidecarClient.runAgent、useSidecarAgentRun、index.ts dispatch → 三个 runtime。
5. **per-runtime 注入**（共享转换器）：
   - 文件文本：所有 runtime 拼进 prompt（普惠，无 vision 依赖）。
   - 图片：Claude→content-block(SDKUserMessage)；Direct→`agent.prompt(txt,images)`+解开 input 门控；Codex→临时文件路径或降级。
   - **vision 探测**：`modelSupportsVision(modelId)` 启发式；非视觉→图片降级为文本提示。
6. **重编译 sidecar**。

## 分阶段（Requirements）
- **阶段 A**：归一化+协议字段+透传 + **文件→抽文本注入所有 runtime** + 删 warning + 前端 pdf.js。→ 所有模型能读文件。
- **阶段 B**：图片 vision 给 Claude + Direct，含 vision 探测 + 非视觉降级文本。
- **阶段 C**：Codex 图片（临时文件）+ 历史多模态 + Anthropic 原生 document block。

## Acceptance Criteria
- [ ] 本地运行下，附文本/代码/PDF 文件，所有模型（claude/openai 兼容/codex）都能在回答中引用文件内容。
- [ ] 本地运行下，附图片，视觉模型（claude-sonnet / gpt-4o / qwen-vl 等）能看图回答。
- [ ] 非视觉模型收到图片 → 收到文本降级提示、不报错。
- [ ] 不再弹「本地运行暂不支持附件」。
- [ ] sidecar 重编译成功；desktop/server typecheck、biome 通过；新增测试覆盖归一化与注入。

## Out of Scope（首版）
- 历史轮次的图片多模态（conversationHistory 仍文本，阶段 C）。
- Anthropic/Gemini 原生文件(document/fileData) block（先统一抽文本，阶段 C 再优化）。

## Technical Notes
- 关键文件见研究结论行号。sidecar 改后必须 `pnpm --filter sidecar run compile:tauri:host`。
- 跨 app 共享类型放 `packages/shared`（按 workspace 名 import）。
