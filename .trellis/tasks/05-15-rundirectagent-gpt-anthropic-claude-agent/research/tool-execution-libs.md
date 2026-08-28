# Research: Coding Agent Tool Execution Libraries

- **Query**: 寻找内置高质量编码工具（文件读写、代码搜索、命令执行、联网搜索）的现成库，可直接 import 使用
- **Scope**: external (npm, GitHub)
- **Date**: 2026-05-13

## Findings Summary

**结论：没有一个完美的"即插即用"编码工具执行库。** 最接近的选项是 `@anthropic-ai/claude-agent-sdk`（但绑定 Claude 模型）和 `bash-tool`（仅 bash/file，需要 Vercel AI SDK）。现有项目 `apps/sidecar/src/agent/direct.ts` 中的自实现工具已经覆盖了核心需求。

---

## 1. `pi-agent-core`

| 属性 | 值 |
|------|-----|
| npm 包名 | `pi-agent-core` |
| 版本 | 0.0.1 |
| 状态 | **占位包 (placeholder)**，无实际代码 |
| 维护者 | mitsuhiko (Armin Ronacher) |
| 评估 | **不可用** — 仅仅是名称占位，没有任何工具实现 |

---

## 2. `@anthropic-ai/claude-agent-sdk`

| 属性 | 值 |
|------|-----|
| npm 包名 | `@anthropic-ai/claude-agent-sdk` |
| 版本 | 0.3.142 (2026-05-14 发布) |
| 仓库 | https://github.com/anthropics/claude-agent-sdk-typescript |
| 依赖 | `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` |
| 许可证 | SEE LICENSE IN README.md (非标准开源) |

### 内置工具（来自 `sdk-tools.d.ts`）

完整工具列表（附输入输出类型定义）：

| 工具名 | 功能 | 输入类型 |
|--------|------|----------|
| `Bash` | 命令执行 | `BashInput { command, timeout?, description?, run_in_background? }` |
| `FileRead` | 文件读取 | `FileReadInput { file_path, offset?, limit?, pages? }` |
| `FileWrite` | 文件写入 | `FileWriteInput { file_path, content }` |
| `FileEdit` | 文件编辑（替换） | `FileEditInput { file_path, old_string, new_string, replace_all? }` |
| `Grep` | 代码搜索 | `GrepInput { pattern, path?, glob?, output_mode?, context?, ... }` |
| `Glob` | 文件名搜索 | `GlobInput { pattern, path? }` |
| `WebSearch` | 联网搜索 | `WebSearchInput { query }` |
| `WebFetch` | 网页抓取 | `WebFetchInput` |
| `NotebookEdit` | Jupyter 编辑 | `NotebookEditInput` |
| `Agent` | 子代理 | `AgentInput { description, prompt, subagent_type? }` |
| `TodoWrite` | TODO 管理 | `TodoWriteInput` |
| `Mcp` | MCP 工具调用 | `McpInput` |

### 架构分析

- **SDK 通过 `query()` 函数启动完整的 Claude Code 会话**，内部会 spawn 一个 Claude CLI 子进程
- **工具执行被封装在 CLI 内部**，`sdk-tools.d.ts` 只暴露了类型定义（输入/输出 schema），不暴露执行函数
- **不能单独使用工具** — 工具的实际执行代码打包在 `sdk.mjs` 的混淆 bundle 中（119行 minified），无法分离引用
- 可以通过 `createSdkMcpServer()` + `tool()` 函数注册**自定义 MCP 工具**

### 关键评估

| 评估项 | 结论 |
|--------|------|
| 现成的高质量工具实现？ | 有，但封装在完整 agent 内部，不可单独提取 |
| 模型无关？ | **否** — 强绑定 Claude API |
| TypeScript/Bun 支持？ | TypeScript 类型齐全，Bun 兼容性未知 |
| 直接 import 工具？ | **不能** — 只能 import 类型定义，不能 import 执行函数 |

---

## 3. `@openai/codex` (Codex CLI)

| 属性 | 值 |
|------|-----|
| npm 包名 | `@openai/codex` |
| 版本 | 0.130.0 |
| 仓库 | https://github.com/openai/codex |
| 依赖 | 无 npm 依赖（平台二进制） |

### 架构分析

- Codex CLI 是**单一打包的原生二进制**（通过 `optionalDependencies` 分发平台二进制包）
- `package.json` 的 `files` 字段只包含 `bin/` 目录
- **没有任何可导入的 API** — 只能作为 CLI 工具调用
- 源码在 `codex-cli/` 目录下用 Rust 实现，工具实现不可复用
- 仓库自带 `rg` (ripgrep) 二进制用于搜索

### 关键评估

| 评估项 | 结论 |
|--------|------|
| 现成的高质量工具实现？ | 有（bash, file edit 等），但 Rust 实现 |
| 模型无关？ | **否** — 强绑定 OpenAI API |
| TypeScript/Bun 支持？ | 原生二进制，无 TS API |
| 直接 import 工具？ | **不能** — 只是 CLI 可执行文件 |

---

## 4. `bash-tool` (Vercel)

| 属性 | 值 |
|------|-----|
| npm 包名 | `bash-tool` |
| 版本 | 1.3.16 |
| 仓库 | https://github.com/vercel-labs/bash-tool |
| 依赖 | `fast-glob`, `just-bash`, `yaml`, `zod` |

### 工具列表

| 工具 | 函数 | 兼容 |
|------|------|------|
| Bash 执行 | `createBashExecuteTool()` | AI SDK `Tool` |
| 文件读取 | `createReadFileTool()` | AI SDK `Tool` |
| 文件写入 | `createWriteFileTool()` | AI SDK `Tool` |

### 特点

- **模型无关** — 工具执行本身不调用任何模型 API
- 通过 `Sandbox` 接口抽象执行环境（支持 `@vercel/sandbox`、`just-bash`、或自定义实现）
- 与 Vercel AI SDK (`ai` 包) 深度集成 — 返回 `import("ai").Tool` 类型
- 支持 before/after hooks 拦截命令
- **缺少关键工具**：没有 grep、glob、file edit (search-replace)、web search

### Sandbox 接口

```typescript
interface Sandbox {
  executeCommand(command: string): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFiles(files: Array<{ path: string; content: string | Buffer }>): Promise<void>;
}
```

### 关键评估

| 评估项 | 结论 |
|--------|------|
| 现成的高质量工具实现？ | 部分 — 只有 bash/read/write，缺少 edit/grep/glob/search |
| 模型无关？ | **是** — 纯工具执行 |
| TypeScript/Bun 支持？ | TypeScript 原生，Bun 兼容性取决于 `just-bash` |
| 直接 import 使用？ | **可以** — 但需要依赖 `ai` 包的 Tool 类型 |

---

## 5. Cline CLI

| 属性 | 值 |
|------|-----|
| npm 包名 | `cline` |
| 版本 | 3.0.3 |
| 仓库 | https://cline.bot |

### 架构分析

- Cline 3.x 也是打包为**原生二进制 CLI**（类似 Codex）
- 无 npm 依赖 → 单体 binary 分发
- **没有可导入的工具 API** — 只能作为 CLI 使用
- 原始 VSCode 扩展版本的工具代码在 GitHub 上可参考，但不可 npm import

### 关键评估

| 评估项 | 结论 |
|--------|------|
| 直接 import 工具？ | **不能** — CLI binary，无 JS/TS API |

---

## 6. Aider

- Aider 是 **Python** 项目，没有 npm 包
- 工具实现在 Python 中（`aider/commands.py`, `aider/io.py` 等）
- **不存在 TypeScript/JS 版本**

---

## 7. SWE-Agent (Princeton)

- SWE-Agent 是 **Python** 项目 (https://github.com/princeton-nlp/SWE-agent)
- 工具集（文件编辑、搜索等）用 Python + Shell 脚本实现
- **没有 JS/TS 版本或 npm 包**

---

## 8. `@mastra/core`

| 属性 | 值 |
|------|-----|
| npm 包名 | `@mastra/core` |
| 版本 | 1.34.0 |
| 定位 | AI 应用框架（类似 LangChain） |

- **框架级**方案，不是工具库
- 提供 tool 定义/注册机制，但没有预置的编码工具实现
- 30+ 依赖，体量巨大 (53.5 MB)
- **不适合**只需要工具执行的场景

---

## 9. `@anthropic-ai/sandbox-runtime`

| 属性 | 值 |
|------|-----|
| npm 包名 | `@anthropic-ai/sandbox-runtime` |
| 版本 | 0.0.51 |
| 定位 | 安全沙箱运行时 |

- 提供 **命令执行沙箱**（filesystem restrictions, network filtering）
- 基于 macOS seatbelt / Linux bubblewrap
- 可以作为工具执行的安全层，但不是工具本身
- 可与自定义工具实现配合使用

---

## 10. `@agentclientprotocol/sdk` (ACP)

| 属性 | 值 |
|------|-----|
| npm 包名 | `@agentclientprotocol/sdk` |
| 版本 | 0.21.1 |
| 定位 | 编辑器与编码 Agent 的通信协议 |

- 定义了编辑器 ↔ Agent 的标准化通信协议
- **不包含工具实现** — 只是协议/消息定义
- 相关包 `@agentclientprotocol/claude-agent-acp` 和 `@zed-industries/codex-acp` 是协议适配层

---

## 现有内部实现分析

文件: `apps/sidecar/src/agent/direct.ts`

当前已有的工具实现：

| 工具 | 质量评估 | 备注 |
|------|----------|------|
| `bash` | 基础 | exec + 30s timeout, 1MB buffer |
| `read_file` | 基础 | 50KB 截断，路径安全检查 |
| `list_dir` | 基础 | 简单 readdir |
| `write_file` | 基础 | 含 mkdir -p |
| `edit_file` | 基础 | 单次 string.replace，无多处替换 |
| `grep` | 基础 | 调用系统 grep，10KB 截断 |
| `glob` | 基础 | 调用系统 find，排除 node_modules/.git |
| `web_search` | 较差 | 仅用 DuckDuckGo instant answer API |

与 Claude Code 内置工具相比的差距：
- 无行号输出、无分页读取
- 无 PDF/图片/notebook 读取
- grep 缺少 context lines、正则选项、ripgrep
- edit_file 不支持多处替换
- 无 web fetch (URL 内容抓取)
- 无安全沙箱

---

## 综合评估矩阵

| 库 | 工具齐全度 | 模型无关 | 可 import | TS/Bun | 推荐度 |
|----|-----------|---------|----------|--------|--------|
| `@anthropic-ai/claude-agent-sdk` | 完整(12+工具) | 否(绑Claude) | 否(只有类型) | TS | 不适合 |
| `@openai/codex` | 完整 | 否(绑OpenAI) | 否(binary) | 无 | 不适合 |
| `bash-tool` | 部分(3工具) | 是 | 是 | TS | 可参考 |
| `cline` | 完整 | 否 | 否(binary) | 无 | 不适合 |
| `@mastra/core` | 无预置工具 | 是 | 是 | TS | 过重 |
| 自实现 (direct.ts) | 基础(8工具) | 是 | 是 | TS+Bun | 当前方案 |

---

## 建议路径（信息提供，不做评判）

基于调研结果，目前生态中存在以下几个可行路径：

1. **继续完善自实现** — 在 `direct.ts` 基础上增强（参考 `claude-agent-sdk` 的 `sdk-tools.d.ts` 类型定义作为高质量工具 schema 参考）
2. **引入 `bash-tool` 作为基础** — 使用其 sandbox 抽象和 bash/readFile/writeFile，自行补充 grep/glob/edit/search
3. **借鉴 `claude-agent-sdk` 的工具 schema** — 其 `sdk-tools.d.ts` 中的工具输入/输出类型定义非常完善，可以作为自实现的接口规范参考
4. **引入 `@anthropic-ai/sandbox-runtime`** — 仅用于安全沙箱层，不依赖其工具

---

## Caveats / Not Found

- 未找到任何**模型无关、完整覆盖编码工具、可直接 import** 的 npm 包
- `pi-agent-core` 是占位包，不存在实际实现
- Anthropic 没有把 Claude Code 的工具执行代码单独发布 — `sdk-tools.d.ts` 只是类型定义
- OpenAI Codex 的工具用 Rust 实现，完全不可用于 TS 项目
- SWE-Agent 和 Aider 都是 Python 项目，无 TS 版本
- 开源编码 Agent (Cline 3.x) 已转为闭源二进制分发
