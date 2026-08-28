# slash 全位置触发 + MCP 图标区分 + MCP 调用可见性

## Goal

三个相关问题一次解决：
1. 用户气泡里的命令 chip 对 MCP 也显示 Sparkles 图标，应按类型区分（skill=Sparkles、mcp=Plug、command=Terminal，与 Composer 面板的 `SLASH_ICONS` 一致）
2. 执行流里认不出 MCP 调用：`presentToolLabel` 把含 search/fetch 的工具名先匹配成 Search/Fetch（MCP 工具如 `mcp__tavily__tavily_search` 会被误标），`mcp__` 分支排最后且只显示 "MCP" 不带服务器/工具名
3. 斜杠只能在输入框「从空开始的开头」触发：先写内容再回到首部输入 `/` 不弹面板；`/` 也不能在文本中间任意位置触发

## Root Cause（已确认）

- chip 图标：`DesktopChatArea.tsx` `MessageBubbleImpl` 用户分支渲染 chip 时硬编码 `<Sparkles>`；`splitLeadingCommand` 只拿到 `commandNames: Set<string>`，没有类型信息
- MCP 标签：`DesktopChatArea.tsx:370-383` `presentToolLabel` 的匹配顺序，`includes("search")/includes("fetch")` 在 `startsWith("mcp__")` 之前；MCP 工具名格式为 `mcp__<server>__<tool>`（sidecar `mcp-tools.ts:114`）
- slash 触发：`DesktopChatArea.tsx:1306-1318` `handleInputChange` 仅当 `value.startsWith("/")` 且 `/` 后无空白才开面板 → 内容非空时回到首部输入 `/`（值为 `/xxx yyy` 含空白）不触发；中间位置更不可能。`handleSlashSelect`（1320-1339）会用 `/name ` 整体替换 input，会清掉已写内容。解析侧 `resolveSkillMcpSlash`（1383-1414）与 `splitLeadingCommand`（744-754）、`slashHighlightLen`（1295-1304）都只认行首 token

## Requirements

### R1 chip 图标按类型区分
- `splitLeadingCommand` 的 known 参数从 `Set<string>` 升级为 `Map<string, "skill" | "mcp" | "command">`（或等价结构），chip 按类型渲染 `SLASH_ICONS` 对应图标（从 Composer 复用或平移常量），蓝色样式不变

### R2 MCP 工具调用可见
- `presentToolLabel` 把 `mcp__` 判断提到所有 includes 匹配之前，显示 `"<server> · <tool>"`（如 `context7 · query-docs`），解析失败回落 "MCP"
- 只改显示层，不动事件协议

### R3 slash 任意位置触发与调用
- 触发：在输入框任意光标位置输入 `/` 都弹出面板；面板 query 取「光标所在的 `/token` 片段」（从 `/` 到光标，遇空白断开）。需要用 `inputRef.current.selectionStart` 判定光标处 token，`handleInputChange` 与光标移动（点击/方向键导致的 selection 变化不强制处理，输入驱动即可）
- 触发条件：`/` 处于行首、空白之后，或输入框开头（即 token 边界），避免路径 `a/b` 误触发
- 选择：`handleSlashSelect` 在光标处 token 位置**就地替换/插入** `/name `，不得清掉其余内容；光标落在插入后
- 解析（发送时）：`resolveSkillMcpSlash` 识别文本中**第一个**处于 token 边界的已知 `/name`，从原文摘除该 token 作为 rest 传入 instruction 包装；一条消息只认一个命令（多命令 out of scope）
- 展示：`splitLeadingCommand`（chip）与 `slashHighlightLen`（输入框蓝色高亮）同步升级为任意位置识别同一规则；chip 展示时 token 保持在原文位置内联（已是 R1 后的行内渲染，token 蓝色 + 其余正文）——若实现上更简单，可统一 displayContent 规范化为 token 提前到行首的形式，但必须保持用户其余文字完整；两种取一，与解析规则一致即可
- 内置 command（如新会话）在任意位置选中后行为不变（执行动作、清理 token）

## Acceptance Criteria

* [ ] 气泡 chip：`/context7 xxx` 显示 Plug 图标，skill 显示 Sparkles，均为蓝色同行内联
* [ ] Agent 运行中 MCP 工具步骤显示 `server · tool` 而非 "Search"/"MCP"
* [ ] 空输入开头输入 `/` → 面板弹出（现状保持）
* [ ] 先写「帮我搜一下新闻」→ 光标移到开头 → 输入 `/` → 面板弹出，选中 context7 后输入变为 `/context7 帮我搜一下新闻`
* [ ] 在句中（空白后）输入 `/web` → 面板过滤出 web-access → 选中后 token 就地插入，前后文字不丢
* [ ] `a/b`、URL 等文本中的 `/` 不触发面板
* [ ] 发送后 chip、蓝色高亮、模型指令包装对任意位置 token 一致生效；edit-and-resend 路径行为一致
* [ ] desktop `npx tsc --noEmit` 通过；`bun test` 全过（基线 57/0）；biome 无新增

## Out of Scope

* 一条消息多个命令
* 光标移动（非输入）时实时开合面板
* sidecar/协议层改动（R2 只改显示）
* Web 端

## Technical Notes

* 涉及文件：`apps/desktop/src/components/chat/DesktopChatArea.tsx`（主）、`apps/desktop/src/components/chat/DesktopComposer.tsx`（面板/高亮 backdrop 若需感知 token 位置）
* Composer 的高亮 backdrop 现在只画行首 `slashHighlightLen` 前缀，任意位置后需要改为「起点+长度」或分段渲染
* 注意与已完成任务的兼容：附件任务改过 startRun 调用点、skill-chip 任务改过 chip 渲染，都在同一文件，保持既有行为
* 关于用户报告的「context7 没被调用」：修完 R2 才能确认——当前标签会把 MCP 调用误显示；另外 context7 是文档查询类 MCP，对新闻搜索类请求模型可能合理地选择 web 工具，这不是 bug，待 R2 落地后由用户复测判断
