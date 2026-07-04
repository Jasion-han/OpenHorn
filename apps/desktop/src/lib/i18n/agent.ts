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
  "settings.credentialSources.description": "自动检测本地 AI 工具认证，或手动添加 API Key",
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
