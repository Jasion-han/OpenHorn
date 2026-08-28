# MCP 设置页连接健康检测

## Goal

用户面对二十多个 MCP 服务器无法判断哪些能用（2026-07-03 实测 23 个启用中 6 个连不上，用户完全不知情）。在 MCP 设置页提供真实的连接测试：单个服务器"测试"按钮 + "全部测试"，显示连接结果、工具数、失败原因。

## 背景事实（已确认）

- `POST /mcp/servers/:id/test`（`routes/mcp.ts:83` → `mcpService.testMCPServer:151`）是**空壳**：只查存在性，无条件 `{success:true}`
- MCP 真实运行环境是 **sidecar**（本地进程、本地 PATH/env），server 容器里测 stdio 命令不真实 → 测试必须走 sidecar
- sidecar 已有 `connectMcpTools`（`apps/sidecar/src/agent/mcp-tools.ts`）：15s 超时、stdio/http/sse 三种 transport——测试复用同一 buildTransport/超时语义，测的才是真实行为
- 注意：任务 07-03-mcp-targeted-connection 正在改 mcp-tools.ts（并行化）、protocol.ts、index.ts、sidecarClient.ts——**本任务必须在其完成后实施**，基于它改后的代码

## Requirements

### R1 sidecar 测试端点
- `protocol.ts` 新增请求/响应消息（如 `mcp_test`）：入参单个服务器 `{ name, config }`，返回 `{ ok: boolean; toolCount?: number; toolNames?: string[]; error?: string; elapsedMs: number }`
- `apps/sidecar/src/index.ts` 路由该消息：用与 `connectMcpTools` 相同的 buildTransport + 15s 超时连接单个服务器，listTools 后立即 close；不影响正在进行的 agent run
- 复用现有代码（从 mcp-tools.ts 导出单服务器连接函数），不复制粘贴 transport 构建逻辑

### R2 desktop 链路与 UI
- `sidecarClient.ts` 暴露 `testMcpServer(server)`；McpSettings.tsx 每行加"测试"按钮 + 顶部"全部测试"（并行、每行独立 loading/结果）
- 结果展示：成功 → 绿色 ✓ + 工具数（hover 可见工具名列表）；失败 → 红色 ✗ + 失败原因（超时/连接关闭/HTTP 状态等原样透传）；测试中 → spinner
- 结果为会话内状态，不落库
- sidecar 未就绪时按钮禁用并提示（复用现有 sidecar status）
- 所有中文文案走 `apps/desktop/src/lib/i18n/agent.ts` 字典，禁止内联中文

### R3 服务端空壳处理
- `testMCPServer` 空壳与桌面新链路并存会误导（永远 success）。桌面 UI 一律改走 sidecar 链路；server 空壳端点保留但在 service 内注明仅存在性检查（web 端未来自行实现），或直接让路由返回 `{ success:false, error:"not implemented" }`——选后者更诚实，检查 web 端无现有调用后执行

### R4 sidecar 重编译
- 改动 `apps/sidecar/src/` 后必须 `pnpm --filter sidecar run compile:tauri:host`

## Acceptance Criteria

* [ ] 设置页对 context7 点"测试"→ 数秒内显示 ✓ 2 个工具
* [ ] 对一个配置损坏的服务器（如指向不存在命令）点"测试"→ 显示 ✗ 与具体原因
* [ ] "全部测试"并行执行，每行独立出结果，总耗时约等于最慢单个（≤15s 量级）
* [ ] 测试期间发起正常 agent run 不互相干扰
* [ ] sidecar 未就绪时按钮禁用有提示
* [ ] 无内联中文；desktop/sidecar tsc 通过；bun test 无新增失败；biome 无新增；sidecar 编译成功

## Out of Scope

* Web 端设置页
* 定时自动巡检、结果持久化
* 按测试结果自动禁用服务器

## Technical Notes

* 前置依赖：07-03-mcp-targeted-connection 完成后再动 mcp-tools.ts/protocol.ts/index.ts/sidecarClient.ts
* McpSettings.tsx 当前无本任务外的未提交改动预期，但 DesktopChatArea 等文件有多批未提交改动，勿碰
* sidecar 安全模型见 `skills/openhorn/rules/sidecar-security.md`：新消息类型注意 handshake token 内的既有鉴权路径，不新开口子
