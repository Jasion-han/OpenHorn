# PRD — 桌面端 MCP 本地工具添加与导入已有配置

## 背景
设置页新增了独立的 **MCP** tab（`McpSettings.tsx`），目前仅支持用裸 JSON 手动「添加 MCP」。
现有 MCP 链路已就绪：`mcp_servers` 表（`type` ∈ stdio/http/sse，`config` 为 JSON），
server CRUD（`/mcp/servers`），桌面端 `api.mcp.*`，运行时在 Claude SDK 模式下加载。

## 目标
1. 让用户方便地把**本机已有的 MCP 配置导入**到 OpenHorn。
2. 添加表单保持现状（裸 JSON），本次只做「导入」。

## 用户决策（已确认）
- 导入方式：**自动探测已知路径 + 手动选配置文件**兜底。
- 探测来源：**Claude Desktop、Cursor、VS Code、Codex CLI**。
- 添加表单：**保持裸 JSON**，不改。

## 范围

### A. Tauri（Rust）新增命令
- `mcp_discover_configs() -> Vec<DiscoveredServer>`
  - 基于 home/config 目录解析 4 个已知路径，存在则读取并解析：
    - Claude Desktop: `<config_dir>/Claude/claude_desktop_config.json`
    - Cursor: `<home>/.cursor/mcp.json`
    - VS Code: `<config_dir>/Code/User/mcp.json`
    - Codex CLI: `<home>/.codex/config.toml`（TOML）
  - 归一化为 `DiscoveredServer { client, name, server_type, config: JSON }`。
- `mcp_read_config_file(path) -> Vec<DiscoveredServer>`：解析用户手动选择的文件（按扩展名/内容判断 json/toml）。
- 解析规则：
  - JSON：兼容 `mcpServers`（Claude/Cursor）与 `servers`（VS Code）两种顶层键。
  - 每个条目：有 `command` → `stdio`，配置取 `{command,args,env}`；有 `url` → `http`/`sse`，配置取 `{url,headers}`。
  - TOML（Codex）：`[mcp_servers.NAME]` → stdio `{command,args,env}`。
- 新增依赖：`toml` crate；注册到 `invoke_handler`。

### B. 桌面端前端
- `serverApi`/Tauri 封装：`discoverMcpConfigs()`、`readMcpConfigFile(path)`。
- `McpSettings.tsx`：在「添加 MCP」旁加「导入」按钮，打开导入弹窗：
  - 打开时调用 `discoverMcpConfigs()`，按 client 分组展示，默认全选，带勾选框。
  - 「选择配置文件…」→ 现有 `tauri-plugin-dialog` 选文件 → `readMcpConfigFile` → 追加到列表。
  - 「全部导入 / 导入所选」→ 对所选逐个 `api.mcp.createServer({name,type,config})` → `loadServers()` 刷新 → toast 导入数量。
  - 同名已存在的 server：标注「已存在」，默认不勾选（避免重复）。

## 非目标
- 不改添加表单为结构化。
- 不做 server 连通性测试（`testMCPServer` 仍是 stub）。
- 不改运行时消费逻辑。
- Windows/Linux 路径尽量用 Tauri 的 config/home 解析做到跨平台，但以 macOS 为主验证。

## 验收
- 在装有 Claude Desktop/Cursor 等并配置过 MCP 的机器上，打开导入弹窗能列出对应 server。
- 勾选导入后，MCP 列表出现对应条目，且 `type`/`config` 正确。
- 手动选一个 `claude_desktop_config.json` 也能解析导入。
- `pnpm --filter desktop exec tsc --noEmit` 通过；`cargo check`（经 dev 构建）通过。
