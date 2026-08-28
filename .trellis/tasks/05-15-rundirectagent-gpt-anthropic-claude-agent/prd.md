# runDirectAgent 完整工具集

## Goal

让 GPT 等非 Anthropic 模型在 Agent 模式下拥有与 Claude Agent SDK 对等的能力。当前 `runDirectAgent`（用于 OpenAI 协议的模型）只有 3 个工具（bash、read_file、list_dir），需要扩展到与 Claude SDK 对等的 8 个工具。

## Requirements

在 `apps/sidecar/src/agent/direct.ts` 的 `TOOLS` 数组中添加以下工具：

1. **write_file** — 写入文件内容（创建或覆盖）
   - 参数：`path`（相对路径）、`content`（文件内容）
   - 安全：路径必须在 workspace 内

2. **edit_file** — 精确字符串替换编辑文件
   - 参数：`path`、`old_string`、`new_string`
   - 安全：路径必须在 workspace 内

3. **grep** — 在文件中搜索文本模式
   - 参数：`pattern`、`path`（可选，默认 `.`）、`include`（可选，文件类型过滤）
   - 实现：调用 `grep -rn`

4. **glob** — 按模式查找文件
   - 参数：`pattern`（如 `**/*.ts`）
   - 实现：调用 `find` 或 Node glob

5. **web_search** — 联网搜索
   - 参数：`query`
   - 实现：调用 Tavily API（从服务端获取 key）或 fetch 搜索引擎

同时需要：
- 所有文件操作工具都要做 workspace 路径校验（不能逃逸到 workspace 外）
- OpenAI 协议的 `OPENAI_TOOLS` 数组同步更新（从 `TOOLS` 自动映射）

## Acceptance Criteria

- [ ] GPT 模型在 Agent 模式下可以读、写、编辑文件
- [ ] GPT 模型在 Agent 模式下可以搜索代码（grep/glob）
- [ ] GPT 模型在 Agent 模式下可以执行 bash 命令
- [ ] GPT 模型在 Agent 模式下可以联网搜索
- [ ] 所有文件操作受 workspace 边界约束
- [ ] TypeScript 类型检查通过
- [ ] Sidecar 编译通过

## Definition of Done

- TypeScript 无类型错误
- Sidecar 编译通过
- 手动测试 GPT 模型执行文件操作和搜索

## Technical Approach

在 `direct.ts` 中：
1. 扩展 `TOOLS` 数组添加 5 个新工具定义
2. 扩展 `executeTool` 函数添加对应实现
3. `OPENAI_TOOLS` 自动从 `TOOLS` 映射，无需额外改动
4. 路径校验复用 `path.resolve(cwd, ...)` + `startsWith(cwd)` 模式

## Out of Scope

- Claude Agent SDK 的修改
- MCP 工具集成
- 工具审批/权限弹窗（当前 sidecar 已有 approval 机制但 direct agent 不使用）

## Technical Notes

- 文件：`apps/sidecar/src/agent/direct.ts`
- `OPENAI_TOOLS` 在第 192 行从 `TOOLS` 自动映射
- `executeTool` 在第 61-108 行实现工具执行逻辑
- workspace 路径校验已有模式：`path.resolve(cwd, filePath)` + `resolved.startsWith(cwd)`
