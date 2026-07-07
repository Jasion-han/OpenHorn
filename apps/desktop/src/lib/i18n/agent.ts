/**
 * Agent i18n dictionary.
 *
 * This file is the ONLY place in the desktop app where user-facing Chinese
 * copy for agent states / errors / actions is allowed to live. Every other
 * source file must look up strings through these helpers instead of
 * hard-coding Chinese text.
 *
 * Rules:
 *   1. All keys are the real state enums / error codes / action ids coming
 *      from the server or the agent SDK. No invented placeholder keys.
 *   2. Every helper returns `null` when a key is missing. Callers must
 *      decide how to degrade (usually: don't render that line) — never
 *      substitute a Chinese fallback outside of this file.
 *   3. Process-stream labels (tool names like Bash / MCP / Skill, status
 *      machine literals like Approved / Rejected) stay in English elsewhere
 *      in the code base. This dictionary is for the *user-facing surface*:
 *      status badges, error messages, action buttons, and empty states.
 */

const agentActionLabels = {
  approve: "通过",
  reject: "拒绝",
  allow: "允许",
  deny: "拒绝",
  stop: "停止",
  retry: "重试",
  continueRun: "继续",
  continueAsk: "继续追问",
  rollback: "回滚此次执行",
  viewDetails: "查看详情",
} as const;

type AgentActionKey = keyof typeof agentActionLabels;

/**
 * Short panel headings and inline hints. These are user-facing copy that
 * does not map to a backend enum, so they live here rather than being
 * inlined as string literals across components.
 */
export const agentPanelLabels = {
  planApprovalHeading: "以下是 Agent 准备执行的计划",
  planApprovalHint: "通过即开始执行；拒绝后任务回到草稿。",
  toolApprovalHeading: "Agent 想要执行以下操作",
  toolApprovalHint: "通过即继续执行；拒绝则当前任务停止。",
  planSectionHeading: "执行计划",
  approvalSubmitting: "提交中...",
  approvalSubmitFailed: "提交失败",
} as const;

/**
 * Labels for the credential sources panel and channel creation flow.
 */
export const credentialLabels = {
  "settings.credentialSources": "认证来源",
  "settings.credentialSources.description":
    "自动检测本地已登录的 AI CLI，用订阅额度认证，免 API key。",
  "settings.credentialSources.detected": "已检测到",
  "settings.credentialSources.notDetected": "未检测到",
  "settings.credentialSources.expired": "已过期",
  "settings.credentialSources.available": "可用",
  "settings.credentialSources.envVar": "环境变量",
  "settings.credentialSources.codexCli": "Codex CLI (ChatGPT Plus)",
  "settings.credentialSources.claudeCode": "Claude Code",
  "settings.credentialSources.geminiCli": "Gemini CLI",
  "settings.credentialSources.manualKey": "手动 API Key",
  "settings.credentialSources.scanning": "正在扫描...",
  "settings.credentialSources.scanFailed": "扫描失败",
  "settings.credentialSources.refreshScan": "重新扫描",
  "channel.selectProvider": "选择 Provider",
  "channel.selectAuth": "选择认证来源",
  "channel.authFromLocal": "使用本地认证",
  "channel.authManual": "手动输入 API Key",
} as const;

type CredentialLabelKey = keyof typeof credentialLabels;

export function getCredentialLabel(key: CredentialLabelKey): string {
  return credentialLabels[key];
}

/**
 * Labels for the Skill settings panel. The literal word "Skill" stays English
 * (it is a process-stream / tool label, per rule 3 above); everything else here
 * is user-facing Chinese copy that must live in this dictionary.
 */
export const skillLabels = {
  "settings.skill.title": "技能（Skill）",
  "settings.skill.description":
    "为 Agent 添加可按需加载的技能。每个技能是一份 SKILL.md（含名称、描述与操作指令）加可选资源文件；启用后会在对话中按需生效。",
  "settings.skill.add": "添加技能",
  "settings.skill.empty": "暂无技能。点击右上角「添加技能」创建。",
  "settings.skill.addTitle": "添加技能",
  "settings.skill.editTitle": "修改技能",
  "settings.skill.name": "名称",
  "settings.skill.nameHint": "小写字母、数字与连字符，≤64 字符",
  "settings.skill.descriptionField": "描述（触发条件）",
  "settings.skill.descriptionHint":
    "模型仅凭这句描述决定是否启用本技能，务必写清「做什么 + 何时用」。例：「处理 PDF 文件：提取文本与表格、填表、合并。当用户提到 PDF、表单或文档抽取时使用。」≤1024 字符。",
  "settings.skill.content": "指令正文（SKILL.md）",
  "settings.skill.contentHint":
    "# 标题\n\n操作步骤、最佳实践、代码片段。建议 <500 行；过长时拆到资源文件并在正文里引用。",
  "settings.skill.files": "资源文件",
  "settings.skill.addFiles": "添加文件…",
  "settings.skill.noFiles": "无资源文件",
  "settings.skill.binary": "二进制",
  "settings.skill.cancel": "取消",
  "settings.skill.create": "创建",
  "settings.skill.save": "保存",
  "settings.skill.saving": "保存中…",
  "settings.skill.edit": "修改",
  "settings.skill.delete": "删除",
  "settings.skill.created": "技能已添加。",
  "settings.skill.updated": "技能已更新。",
  "settings.skill.deleted": "技能已删除。",
  "settings.skill.statusUpdated": "技能状态已更新。",
  "settings.skill.loadFailed": "无法加载技能。",
  "settings.skill.createFailed": "无法创建技能。",
  "settings.skill.updateFailed": "无法更新技能。",
  "settings.skill.deleteFailed": "无法删除技能。",
  "settings.skill.nameRequired": "请填写技能名称。",
  "settings.skill.descRequired": "请填写技能描述。",
  "settings.skill.fileReadFailed": "无法读取所选文件。",
  "settings.skill.savedOk": "已保存",
  "settings.skill.createdOk": "已创建",
  "settings.skill.deletedOk": "已删除",
  "settings.skill.updatedOk": "已更新",
  "settings.skill.failed": "操作失败",
  "settings.skill.import": "导入",
  "settings.skill.importTitle": "导入本地技能",
  "settings.skill.importDescWithSources":
    "已扫描到 {sources} 的本地技能；同一技能合并为一条，标签标出它在哪些平台安装过。勾选要导入的技能，或手动选择技能文件夹。",
  "settings.skill.importDesc": "勾选要导入的技能，或手动选择一个技能文件夹导入。",
  "settings.skill.scanning": "正在扫描本地技能…",
  "settings.skill.scanFailed": "无法扫描本地技能。",
  "settings.skill.noFound": "未发现可导入的技能。可点击上方「选择文件夹…」手动导入。",
  "settings.skill.exists": "已存在",
  "settings.skill.pickFolder": "选择文件夹…",
  "settings.skill.selectAll": "全选",
  "settings.skill.deselectAll": "取消全选",
  "settings.skill.selectedCount": "已选 {selected} / {total}",
  "settings.skill.importSelected": "导入所选（{count}）",
  "settings.skill.importing": "导入中…",
  "settings.skill.imported": "成功导入 {count} 个技能。",
  "settings.skill.importPartialFail": "成功 {ok} 个，失败 {failed} 个：{names}",
  "settings.skill.importedOk": "已导入",
  "settings.skill.noSelection": "请至少勾选一个要导入的技能。",
  "settings.skill.folderInvalid": "所选文件夹不是有效的技能（缺少 SKILL.md）。",
} as const;

type SkillLabelKey = keyof typeof skillLabels;

export function getSkillLabel(key: SkillLabelKey): string {
  return skillLabels[key];
}

/**
 * Labels for the MCP settings connection health check. Raw failure reasons
 * (timeouts, HTTP statuses) come from the sidecar verbatim and stay English;
 * this dictionary only covers the surrounding user-facing copy.
 */
export const mcpLabels = {
  "settings.mcp.test": "测试",
  "settings.mcp.testAll": "全部测试",
  "settings.mcp.testingAll": "测试中…",
  "settings.mcp.toolCount": "{count} 个工具",
  "settings.mcp.sidecarNotReady": "本地运行时未就绪，无法测试连接",
} as const;

type McpLabelKey = keyof typeof mcpLabels;

export function getMcpLabel(key: McpLabelKey): string {
  return mcpLabels[key];
}

/**
 * Labels for the channel settings panel (list, actions, model management and the
 * Agent compatibility check dialog). Raw provider/base-url/model ids stay verbatim
 * (they come from the server); "modelId", "Base URL", "Agent", "MCP", "Coding Plan"
 * and product names stay English per rule 3 above. Templates use `{name}`
 * placeholders resolved via `formatChannelLabel`.
 */
export const channelLabels = {
  // Section
  "settings.channel.title": "渠道配置",
  "settings.channel.description": "全局用户级配置，对话与 Agent 共用。",
  "settings.channel.manageButton": "渠道管理",
  // Badges
  "settings.channel.badge.default": "默认",
  "settings.channel.badge.missingDefaultModel": "缺少默认模型",
  "settings.channel.badge.disabled": "已禁用",
  "settings.channel.baseUrlUnset": "未设置 Base URL",
  // Row actions (aria-label + tooltip)
  "settings.channel.action.edit": "编辑渠道",
  "settings.channel.action.agentCheck": "Agent 检查",
  "settings.channel.action.test": "连接测试",
  "settings.channel.action.syncModels": "同步模型",
  "settings.channel.action.setDefault": "设为默认",
  "settings.channel.action.collapse": "收起",
  "settings.channel.action.expand": "展开",
  "settings.channel.action.delete": "删除渠道",
  // Model management
  "settings.channel.models.heading": "模型",
  "settings.channel.models.syncedCount": "已同步 {count} 个，可手动补充 modelId",
  "settings.channel.models.addPlaceholder": "手动添加 modelId，例如：qwen3.5-plus",
  "settings.channel.models.addButton": "添加",
  "settings.channel.models.dashscopeHint":
    "百炼/Coding Plan 不支持接口查询模型列表，可直接手动添加，例如： qwen3.5-plus、qwen3-coder-next、glm-5、kimi-k2.5。",
  "settings.channel.models.empty":
    "当前还没有模型。该渠道如果不支持同步，可直接在上方手动添加 modelId。",
  "settings.channel.model.remove": "移除",
  // Empty / loading states
  "settings.channel.emptyState": "还没有配置渠道，先新增一个渠道。",
  "settings.channel.loading": "正在加载渠道...",
  "settings.channel.applying": "正在应用配置...",
  // Inline notice card
  "settings.channel.notice.needsAttentionTitle": "需要处理",
  "settings.channel.notice.syncFailedTitle": "同步失败",
  "settings.channel.notice.dismiss": "关闭提示",
  // Agent compatibility check dialog
  "settings.channel.agentCheck.dialogTitle": "Agent 兼容性检查",
  "settings.channel.agentCheck.dialogDescription":
    "为当前渠道和模型执行一次真实的 Agent 兼容性检查。",
  "settings.channel.agentCheck.selectChannel": "请选择一个渠道。",
  "settings.channel.agentCheck.modelIdPlaceholder": "例如：claude-4.6-sonnet",
  "settings.channel.agentCheck.selectModelId": "选择 modelId",
  "settings.channel.agentCheck.modelDisabledSuffix": "（已禁用）",
  "settings.channel.agentCheck.cancel": "取消",
  "settings.channel.agentCheck.start": "开始检查",
  "settings.channel.agentCheck.defaultError": "当前配置不能用于 Agent。",
  "settings.channel.agentCheck.retryPhrase": "请稍后重试",
  "settings.channel.agentCheck.retrySuffix": " 可稍后重试。",
  // Agent check error titles (keyed by server errorCode)
  "settings.channel.agentCheck.error.modelNotFound": "模型不可用",
  "settings.channel.agentCheck.error.authFailed": "鉴权失败",
  "settings.channel.agentCheck.error.quotaExhausted": "配额不足",
  "settings.channel.agentCheck.error.sslHandshakeFailed": "SSL 握手失败",
  "settings.channel.agentCheck.error.gatewayFailed": "网关异常",
  "settings.channel.agentCheck.error.timeout": "请求超时",
  "settings.channel.agentCheck.error.protocolIncompatible": "协议不兼容",
  "settings.channel.agentCheck.error.default": "Agent 检查失败",
  // Toasts
  "settings.channel.notify.loadFailedTitle": "加载失败",
  "settings.channel.notify.loadFailedBody": "无法加载渠道列表。",
  "settings.channel.notify.fetchModelsFailedBody": "无法获取模型列表。",
  "settings.channel.notify.actionFailedTitle": "操作失败",
  "settings.channel.notify.actionFailedBody": "渠道操作失败。",
  "settings.channel.notify.deletedTitle": "已删除",
  "settings.channel.notify.deletedBody": "渠道已删除。",
  "settings.channel.notify.testSuccessTitle": "连接成功",
  "settings.channel.notify.testSuccessBody": "该渠道可正常连接。",
  "settings.channel.notify.testFailedTitle": "连接失败",
  "settings.channel.notify.testFailedBody": "无法连接该渠道。",
  "settings.channel.notify.syncDoneWarnTitle": "同步已完成",
  "settings.channel.notify.syncDoneWarnBody": "模型列表已刷新，但该渠道还有待处理项。",
  "settings.channel.notify.syncSuccessTitle": "同步成功",
  "settings.channel.notify.syncSuccessBody": "模型列表已更新。",
  "settings.channel.notify.missingModelTitle": "缺少模型",
  "settings.channel.notify.missingModelBody": "请选择或输入 modelId。",
  "settings.channel.notify.agentOkTitle": "Agent 可用",
  "settings.channel.notify.agentOkBody": "模型 {modelId} 已通过 Agent 兼容性检查。",
  "settings.channel.notify.updatedTitle": "已更新",
  "settings.channel.notify.defaultChannelUpdatedBody": "默认渠道已更新。",
  "settings.channel.notify.modelEnabledUpdatedBody": "模型启用状态已保存。",
  "settings.channel.notify.defaultModelUpdatedBody": "默认模型已更新。",
  "settings.channel.notify.missingModelIdTitle": "缺少 modelId",
  "settings.channel.notify.missingModelIdBody": "请输入要添加的 modelId。",
  "settings.channel.notify.modelExistsTitle": "模型已存在",
  "settings.channel.notify.modelExistsBody": "{modelId} 已在当前渠道中。",
  "settings.channel.notify.addedTitle": "已添加",
  "settings.channel.notify.addedBody": "{modelId} 已加入当前渠道。",
  "settings.channel.notify.removedTitle": "已移除",
  "settings.channel.notify.removedBody": "{modelId} 已从当前渠道移除。",
  // Channel editor modal — dialog chrome + list
  "settings.channel.editor.dialogDescription":
    "管理桌面端渠道配置，包括 provider、Base URL、API Key 和模型同步。",
  "settings.channel.editor.listHeading": "渠道",
  "settings.channel.editor.newButton": "新建",
  "settings.channel.editor.searchPlaceholder": "搜索渠道...",
  "settings.channel.editor.unnamedChannel": "未命名渠道",
  "settings.channel.editor.noMatch": "没有匹配的渠道",
  "settings.channel.editor.createTitle": "新建渠道",
  "settings.channel.editor.editTitle": "编辑渠道",
  "settings.channel.editor.providerHint":
    "provider 用于标识该渠道兼容的接口类型，保存后会自动同步模型列表。",
  // Channel editor modal — form fields
  "settings.channel.editor.nameLabel": "名称",
  "settings.channel.editor.namePlaceholder": "例如：我的 Claude 中转",
  "settings.channel.editor.providerPlaceholder": "例如：anthropic / openrouter / my-relay",
  "settings.channel.editor.presetsLabel": "常见预设",
  "settings.channel.editor.baseUrlPlaceholder": "例如：https://api.anthropic.com",
  "settings.channel.editor.fillDefaultBaseUrl": "填入当前默认 Base URL",
  "settings.channel.editor.suggestedBaseUrl": "当前建议地址：{url}",
  "settings.channel.editor.baseUrlHint":
    "会根据 provider 与 Base URL 自动判断兼容链路；中转服务填写兼容类型即可。",
  "settings.channel.editor.enableLabel": "启用该渠道",
  "settings.channel.editor.localAuthHint":
    "Sidecar 将自动使用检测到的本地认证，无需手动填写 API Key。",
  "settings.channel.editor.apiKeyPlaceholderCreate": "输入 API Key",
  "settings.channel.editor.apiKeyPlaceholderEdit": "保持为 ******** 或留空表示不修改",
  "settings.channel.editor.apiKeyHint":
    "出于安全原因，不会展示已保存的明文 Key。输入新 Key 才会更新。",
  "settings.channel.editor.fillFromSource": "从 {source} 填入",
  // Channel editor modal — footer buttons
  "settings.channel.editor.processing": "处理中...",
  "settings.channel.editor.createAndSync": "创建并同步模型",
  "settings.channel.editor.saveAndSync": "保存并同步模型",
  // Channel editor modal — validation / toasts
  "settings.channel.editor.saveErrorTitle": "无法保存",
  "settings.channel.editor.createErrorTitle": "无法创建",
  "settings.channel.editor.nameRequired": "请填写渠道名称。",
  "settings.channel.editor.providerRequired": "请填写 provider。",
  "settings.channel.editor.apiKeyRequired": "请填写 API Key。",
  "settings.channel.editor.noLocalAuth": "未检测到匹配的本地认证来源。",
  "settings.channel.editor.channelNotFound": "目标渠道不存在。",
  "settings.channel.editor.saveFailedGeneric": "无法保存当前渠道。",
  "settings.channel.editor.createdTitle": "渠道已创建",
  "settings.channel.editor.savedTitle": "渠道已保存",
  "settings.channel.editor.createdSyncFailed":
    "渠道已保存，但模型同步失败。请看列表中的提示并继续处理。",
  "settings.channel.editor.createdSyncWarn": "渠道已保存，模型同步结果请看列表中的提示。",
  "settings.channel.editor.createdSyncOk": "渠道已保存，并已同步模型列表。",
  "settings.channel.editor.savedSyncFailed":
    "已保存渠道，但模型同步失败。请看列表中的提示并继续处理。",
  "settings.channel.editor.savedSyncWarn": "已保存渠道，模型同步结果请看列表中的提示。",
  "settings.channel.editor.savedSyncOk": "已保存渠道，并已同步模型列表。",
  "settings.channel.editor.filledTitle": "已填入",
  "settings.channel.editor.filledBody": "已使用 {source} 的 API Key",
  "settings.channel.editor.fetchKeyFailedTitle": "获取失败",
  "settings.channel.editor.unknownError": "未知错误",
} as const;

type ChannelLabelKey = keyof typeof channelLabels;

export function getChannelLabel(key: ChannelLabelKey): string {
  return channelLabels[key];
}

/**
 * Resolves a channel label template, substituting `{name}` placeholders with the
 * provided values. Used for the few interpolated toast/inline strings.
 */
export function formatChannelLabel(
  key: ChannelLabelKey,
  vars: Record<string, string | number>,
): string {
  let text: string = channelLabels[key];
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/**
 * Labels for the composer slash-command panel (type `/` to open). Group titles
 * and built-in command names are user-facing Chinese copy; the literal trigger
 * "/" and tool words (MCP / Skill) stay English per rule 3 above.
 */
export const slashLabels = {
  "slash.group.skill": "技能",
  "slash.group.mcp": "MCP 工具",
  "slash.group.command": "命令",
  "slash.command.newConversation": "新会话",
  "slash.command.newConversation.desc": "开始一个新的会话",
  "slash.command.openSettings": "打开设置",
  "slash.command.openSettings.desc": "前往设置页面",
  "slash.empty": "无匹配的命令",
  // {name} = skill/mcp name, {rest} = the user's remaining request text.
  "slash.instruction.skill":
    "[本轮请使用「{name}」技能：先用你的文件读取工具读取它的 SKILL.md 并严格遵循其中的指令，再完成下面的请求。]\n\n{rest}",
  "slash.instruction.mcp": "[本轮请优先使用名为「{name}」的 MCP 工具来完成下面的请求。]\n\n{rest}",
} as const;

type SlashLabelKey = keyof typeof slashLabels;

export function getSlashLabel(key: SlashLabelKey): string {
  return slashLabels[key];
}

export function getAgentActionLabel(action: AgentActionKey): string {
  return agentActionLabels[action];
}
