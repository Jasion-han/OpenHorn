# OpenHorn 技术方案设计文档

**项目名称**: OpenHorn  
**版本**: v1.0.0  
**日期**: 2026-03-09  
**状态**: 初稿

---

## 一、项目概述

OpenHorn 是一个完整的 AI 应用，包含网页端、桌面端和后端服务。基于 Monorepo 架构，支持多设备使用，具备 Agent 自动化、知识库等高级功能。

### 1.1 核心特性

- 多模型对话 (OpenAI / Anthropic / DeepSeek / Google)
- Agent 自动化 (Claude Agent SDK)
- 本地知识库 (RAG + LanceDB)
- MCP 工具集成
- 网页 + 桌面端双端支持

### 1.2 目标用户

- 个人开发者
- AI 爱好者
- 需要本地优先的 AI 工具用户

---

## 二、技术栈

### 2.1 核心技术

| 层级 | 技术 | 版本 |
|------|------|------|
| 运行时 | Bun | ^1.2 |
| 包管理 | pnpm | ^9 |
| 前端 | Next.js 15 (App Router) | ^15 |
| UI | Mantine | 7 |
| 状态 | Zustand | ^5 |
| 服务端状态 | TanStack Query | ^5 |
| 表单 | React Hook Form + Zod | ^7 |
| 后端 | Hono | ^4 |
| ORM | Drizzle ORM | ^0.39 |
| 数据库 | SQLite / MySQL | - |
| 代码规范 | Biome | ^2 |
| 构建 | Turbo | ^2 |

### 2.2 桌面端

| 方案 | 工具 |
|------|------|
| 推荐 | Tauri 2.0 |
| 备选 | Electron 35 |

### 2.3 AI / Agent 层

| 组件 | 技术 |
|------|------|
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| 向量库 | LanceDB |
| 工具协议 | MCP |

### 2.4 安全

| 项目 | 方案 |
|------|------|
| API Key 加密 | AES-256-GCM |
| 认证 | JWT |
| 密码哈希 | bcrypt |

---

## 三、项目结构

```
OpenHorn/
├── apps/
│   ├── web/              # Next.js 网页应用
│   ├── desktop/         # Tauri 桌面应用
│   └── server/         # Hono API 服务
├── packages/
│   ├── ui/             # 共享 UI 组件
│   ├── shared/         # 共享类型 + 常量
│   ├── agent/         # Agent 核心逻辑
│   └── db/            # 数据库相关
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
├── biome.json
└── README.md
```

---

## 四、API 设计

| 路由 | 方法 | 说明 |
|------|------|------|
| /auth/* | * | 认证 |
| /channels/* | CRUD | 渠道管理 |
| /conversations/* | CRUD | 对话管理 |
| /messages/* | POST/GET | 消息 |
| /agent/* | * | Agent |
| /workspaces/* | CRUD | 工作区 |
| /mcp/* | CRUD | MCP 配置 |

---

## 五、部署方案

| 环境 | 方案 |
|------|------|
| 网页端 | Vercel / Cloudflare Pages |
| 桌面端 | Tauri bundler |
| 后端 | Docker |

---

## 六、数据库 Schema

- users
- channels
- conversations
- messages
- agent_sessions
- workspaces
- mcp_servers
- attachments
- settings

---

## 七、开发计划

### Phase 1: 基础框架
- [ ] 初始化 Monorepo
- [ ] 搭建 Next.js + Mantine
- [ ] 搭建 Hono + Drizzle

### Phase 2: 核心功能
- [ ] 渠道管理
- [ ] 对话功能
- [ ] 流式响应

### Phase 3: Agent
- [ ] Agent SDK 集成
- [ ] 工具系统

### Phase 4: 桌面端
- [ ] Tauri 集成

---

## 八、成本

- 域名: ~$12/年
- 服务器: 可选 ($0-20/月)
- AI API: 用户自付

---

*本文档为技术方案设计初稿*
