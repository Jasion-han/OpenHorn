---
date: 2026-03-12
feature: desktop-sidecar-ide-mvp
status: approved
---

# Desktop（macOS）Sidecar IDE MVP 设计

## 背景

目标是做一个偏 “Cursor / Claude Code” 形态的桌面端练手项目：以本地 Workspace（项目目录）为中心，具备内置编辑器、AI 自动改代码/打补丁、终端跑命令等能力；同时支持账号注册登录，后续可扩展额度/计费与更多云端能力。

约束与前置决策：
- 大模型推理在线：允许请求直接到模型供应商（Anthropic/OpenAI/…）
- 隐私边界：本地代码/文件内容不经过 OpenHorn 云端 Server
- BYOK：MVP 阶段 API Key 不做跨设备同步（仅本机保存）

## 目标（MVP）

- **macOS 桌面端**
  - 打开 Workspace（选择文件夹）
  - 文件树浏览
  - Monaco 编辑器：多标签、编辑/保存、基础搜索
  - 终端：在 Workspace 内执行命令并实时输出
- **Agent（本地）**
  - 仅支持 **Anthropic（Claude Agent SDK）** 的 Agent 模式（工具调用 + 自动改代码）
  - 支持工具：`fs.*` / `patch.apply` / `shell.run`
  - 默认自动写入文件，并提供内置快照回滚（checkpoint）
- **账号**
  - Desktop 使用 `Authorization: Bearer <token>`（Web 端可继续 cookie）
  - 登录用于“账号体系/后续扩展”，MVP 不用于代理模型调用

## 非目标（MVP 不做）

- LSP（补全/跳转/诊断/重命名）
- MCP（先不接入）
- 供应商通用 Agent runtime（先不做 OpenAI/DeepSeek/Google 的工具调用）
- API Key 跨设备同步（E2EE Key Vault 后续再做）
- 团队空间/协作与共享 Workspace

## 方案选择

采用：**Tauri（壳） + Vite（桌面 UI） + Bun Sidecar（本地 agent runtime）**。

动机：
- 更贴近成熟产品形态：UI 与 runtime 解耦，本地 agent 进程更便于扩展
- 避免桌面端打包时引入 Next.js SSR/运行时负担
- 可把现有服务端 Claude Agent SDK 适配逻辑迁移到 sidecar，复用事件结构

## 总体架构

### 进程
- **Tauri App**
  - 启动/守护 sidecar 进程
  - 为 UI 提供 sidecar 地址与握手 token
- **Desktop UI（Vite + React + Mantine + Monaco）**
  - IDE UI：文件树、编辑器、Agent 面板、终端面板、快照回滚入口
- **Sidecar（Bun）**
  - WebSocket 服务（127.0.0.1 随机端口）
  - Agent runtime（Claude Agent SDK）
  - 本地工具：文件/补丁/命令执行（含安全护栏）
- **OpenHorn Server（云端）**
  - 用户注册/登录/Me
  - （可选）用量/事件上报（不含代码内容）

### 通信与安全

UI ↔ sidecar：WebSocket（推荐全双工、易支持流式输出与取消）。

安全模型（MVP）：
- sidecar 仅监听 `127.0.0.1`
- 使用随机端口
- Tauri 启动时生成一次性 **握手 token**
- UI 建连后必须先发 `auth`（携带 token），通过后才允许其它 RPC

## 数据与存储

### Workspace（本机）
- 列表仅本机保存（不上传云端）
- Workspace path 仅用于本地 sidecar 访问文件系统

### BYOK（本机）
- API Key：本机保存（优先 Keychain）
- provider/baseUrl/defaultModel 等非敏感配置：本机保存（sidecar config）

### 登录 token（本机）
- Desktop 登录后保存 token（本机安全存储）
- 后续访问 OpenHorn 云端接口走 Bearer

## Agent（MVP：Anthropic Only）

### 为什么只做 Claude Agent SDK
- Claude Agent SDK 为 Anthropic 专用，不能作为“通用多供应商 agent SDK”
- MVP 只做 Anthropic Agent，可快速跑通“工具调用 → 改代码 → 跑命令”闭环

### 工具集（MVP）
- `fs.list/read/write/stat`
- `fs.search`（文件名/内容检索，先做简单版）
- `patch.applyUnifiedDiff`（可选：也支持 raw write）
- `shell.run`（流式输出）

## 改代码落盘 + 快照回滚（Checkpoint）

### 行为
- 默认：Agent 直接写文件（自动落盘）
- 在**每次 Agent run**开始时创建 checkpoint（或在“首次写入前”创建一次 checkpoint）
- UI 提供“一键回滚到该 checkpoint”

### 存储位置
- `<workspace>/.openhorn/snapshots/<runId>/...`
- 默认在文件树中隐藏 `.openhorn`
- 若 workspace 是 git repo，自动写入 `.gitignore` 忽略 `.openhorn/`

### 覆盖范围
- **仅覆盖 Agent 通过工具写文件/打补丁造成的改动**
- `shell.run` 命令导致的文件改动 **不纳入回滚**（与 Claude Code 的 checkpoint 限制对齐）

## 终端与命令安全护栏

默认行为：
- 命令默认自动执行（提升 agent 体验）

强制确认（命中任一即弹窗/确认）：
- 明显高风险：`rm -rf`、`sudo`、`chmod/chown`、`mkfs/dd`、fork bomb、`curl|bash`/`wget|sh` 等
- 疑似写出 Workspace 边界
- 疑似外传/下载并执行脚本等高风险行为

终端面板必须长期可追溯：
- `cwd`、完整命令、退出码、stdout/stderr、执行时间

## 登录与“额度”的 MVP 定义

### 鉴权
- Web：cookie
- Desktop：Bearer

### 额度（MVP）
在“BYOK + 本地直连供应商”的模式下，云端无法强约束 API 成本；MVP 的额度只做：
- 功能门槛（例如某些高级能力需要登录）
- 频率/并发限制（本机与云端均可做，但不等价计费）

后续若要真正计费/额度：
- 平台代付（云端代理模型调用），或
- E2EE Key Vault + 云端可信执行（复杂）

## 风险与后续演进

- Sidecar 打包：需要把 sidecar 以可执行文件形式随 Tauri app 分发（例如 Bun compile）
- 未来跨平台：Windows/Linux 的文件锁/路径/权限差异与 WebView 差异需要额外处理
- LSP 与 MCP：建议在 MVP 闭环后再逐步加入

