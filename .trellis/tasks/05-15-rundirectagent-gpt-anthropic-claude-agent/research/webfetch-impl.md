# Research: WebFetch 工具实现调研

- **Query**: 调研成熟产品的 WebFetch（获取网页内容）工具怎么实现的
- **Scope**: mixed (internal + external)
- **Date**: 2026-05-13

---

## 1. Claude Code 的 WebFetch 工具实现（来自 sourcemap 逆向）

### 1.1 工具定义（SDK 类型）

**文件**: `@anthropic-ai/claude-code/sdk-tools.d.ts`

```typescript
export interface WebFetchInput {
  url: string;    // The URL to fetch content from
  prompt: string; // The prompt to run on the fetched content
}
```

**关键设计**: Claude Code 的 WebFetch 不仅仅抓取内容，还接受一个 `prompt` 参数。抓取内容后，会用一个**小模型（Haiku）**对内容进行二次处理/摘要，再返回给主模型。

### 1.2 核心实现流程

**文件**: `src/tools/WebFetchTool/WebFetchTool.ts`
**文件**: `src/tools/WebFetchTool/utils.ts`

完整流程：

```
URL 输入
  ↓
validateURL() — 校验 URL 合法性（长度 ≤ 2000, 无 username/password, 有公共域名）
  ↓
checkDomainBlocklist() — 调用 api.anthropic.com 检查域名是否被封锁
  ↓
HTTP 升级 — http → https 自动升级
  ↓
getWithPermittedRedirects() — axios GET 请求，手动处理重定向（安全策略：不自动跟随跨域重定向）
  ↓
内容类型判断:
  ├─ text/html → Turndown 转 Markdown
  ├─ text/markdown → 直接使用
  └─ 二进制 (PDF等) → 存盘 + UTF-8 decode 后也传给 Haiku
  ↓
截断 → MAX_MARKDOWN_LENGTH = 100,000 字符
  ↓
applyPromptToMarkdown() → 调用 Haiku 小模型做摘要/提取
  ↓
返回结果
```

### 1.3 关键常量与限制

| 常量 | 值 | 用途 |
|------|-----|------|
| `MAX_URL_LENGTH` | 2000 | URL 最大长度 |
| `MAX_HTTP_CONTENT_LENGTH` | 10 MB | HTTP 响应体最大大小 |
| `FETCH_TIMEOUT_MS` | 60,000 ms | 请求超时 |
| `MAX_REDIRECTS` | 10 | 最大重定向跳数 |
| `MAX_MARKDOWN_LENGTH` | 100,000 字符 | Markdown 截断阈值 |
| `maxResultSizeChars` | 100,000 字符 | 工具结果持久化阈值 |
| `CACHE_TTL_MS` | 15 分钟 | URL 缓存有效期 |
| `MAX_CACHE_SIZE_BYTES` | 50 MB | LRU 缓存最大容量 |
| `DOMAIN_CHECK_TIMEOUT_MS` | 10,000 ms | 域名检查超时 |

### 1.4 HTML 转 Markdown：使用 Turndown

```typescript
// 懒加载单例模式，避免首次加载 ~1.4MB 的 DOM 库
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

// 使用时：
if (contentType.includes('text/html')) {
  markdownContent = (await getTurndownService()).turndown(htmlContent)
} else {
  markdownContent = htmlContent  // 非 HTML 直接用原文
}
```

### 1.5 二次处理：Haiku 小模型摘要

```typescript
export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  isPreapprovedDomain: boolean,
): Promise<string> {
  // 截断
  const truncatedContent = markdownContent.length > MAX_MARKDOWN_LENGTH
    ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated due to length...]'
    : markdownContent

  // 构建 prompt
  const modelPrompt = makeSecondaryModelPrompt(truncatedContent, prompt, isPreapprovedDomain)

  // 调用 Haiku
  const assistantMessage = await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: modelPrompt,
    signal,
    options: { querySource: 'web_fetch_apply', ... },
  })
  // 返回 Haiku 的文本回复
}
```

**为什么用小模型做二次处理？**
- 大页面内容 token 量巨大，直接塞进主对话上下文会浪费 token
- Haiku 便宜、快速，适合做提取/摘要
- 通过 `prompt` 参数让 Haiku 只提取需要的信息

### 1.6 安全机制

1. **域名黑名单**: 通过 `api.anthropic.com/api/web/domain_info` 检查
2. **预批准域名列表**: ~130 个开发者相关站点（见 `preapproved.ts`），无需用户确认
3. **重定向安全**: 不自动跟随跨域重定向，仅允许同域或 www ↔ non-www
4. **URL 验证**: 无 username/password, 长度限制, 必须有公共域名
5. **权限系统**: 按域名粒度的 allow/deny/ask 规则
6. **版权保护**: 非预批准域名的引用限制在 125 字符以内

### 1.7 缓存策略

```typescript
// LRU 缓存，按 URL 键值
const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: 50 * 1024 * 1024,  // 50MB
  ttl: 15 * 60 * 1000,         // 15 分钟
})

// 域名检查缓存（避免同域名多次检查）
const DOMAIN_CHECK_CACHE = new LRUCache<string, true>({
  max: 128,
  ttl: 5 * 60 * 1000,  // 5 分钟
})
```

### 1.8 输出结构

```typescript
interface Output {
  bytes: number;       // 内容字节数
  code: number;        // HTTP 状态码
  codeText: string;    // HTTP 状态文本
  result: string;      // 处理后的结果（Haiku 摘要 或 原始 Markdown）
  durationMs: number;  // 耗时
  url: string;         // 请求的 URL
}
```

---

## 2. Anthropic API 服务端 WebFetch 工具（Server-Side Tool）

### 2.1 工具版本演进

| 版本 | 类型标识 | 新增能力 |
|------|---------|---------|
| `web_fetch_20250910` | 初版 | 基础 fetch |
| `web_fetch_20260209` | 中间版 | 同上，可能内部改进 |
| `web_fetch_20260309` | 最新版 | 新增 `use_cache` 参数 |

### 2.2 服务端工具配置

```typescript
interface WebFetchTool20260309 {
  name: 'web_fetch';
  type: 'web_fetch_20260309';
  allowed_callers?: Array<'direct' | 'code_execution_20250825' | 'code_execution_20260120'>;
  allowed_domains?: Array<string> | null;
  blocked_domains?: Array<string> | null;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  defer_loading?: boolean;
  max_content_tokens?: number | null;  // 关键：限制内容 token 数
  max_uses?: number | null;            // 最大调用次数
  strict?: boolean;
  use_cache?: boolean;                 // 新版：是否使用缓存
}
```

### 2.3 服务端返回结构

```typescript
interface WebFetchBlock {
  content: DocumentBlock;              // 文档内容块
  retrieved_at: string | null;         // ISO 8601 获取时间
  type: 'web_fetch_result';
  url: string;                         // 获取的 URL
}

// 错误码
type WebFetchToolResultErrorCode =
  | 'invalid_tool_input'
  | 'url_too_long'
  | 'url_not_allowed'
  | 'url_not_accessible'
  | 'unsupported_content_type'
  | 'too_many_requests'
  | 'max_uses_exceeded'
  | 'unavailable';
```

**关键区别**: 服务端 web_fetch 返回的是 `DocumentBlock`（结构化文档块），不是纯文本 — 这意味着 Anthropic 服务端做了更深入的内容提取和结构化。

---

## 3. earendil-works/pi 工具集（Claude Code SDK 参考实现）

**文件**: `packages/coding-agent/src/core/tools/index.ts`

该开源实现**没有 WebFetch 工具**。工具列表仅包含:
- `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

这说明 WebFetch 不是一个通用的 coding agent 基础工具，而是 Claude Code 的专有增强。

---

## 4. HTML 转换库对比

### 4.1 turndown（Claude Code 的选择）

| 属性 | 值 |
|------|-----|
| 版本 | 7.2.4 |
| 描述 | A library that converts HTML to Markdown |
| 仓库 | github.com/mixmark-io/turndown |
| 输出格式 | Markdown |
| 特点 | 规则驱动，可自定义；有插件系统（GFM 表格等） |
| 内存 | ~1.4MB 保留堆（含 @mixmark-io/domino DOM 实现） |

**Claude Code 为什么选 turndown？**
- 输出 Markdown，LLM 理解 Markdown 效果最好
- 保留文档结构（标题、列表、链接、代码块）
- 单例可复用，构造一次后 `.turndown()` 是无状态的

### 4.2 html-to-text

| 属性 | 值 |
|------|-----|
| 版本 | 10.0.0 |
| 描述 | Advanced html to plain text converter |
| 仓库 | github.com/html-to-text/node-html-to-text |
| 输出格式 | 纯文本 |
| 特点 | 高度可配置的格式化选项；擅长邮件文本化 |

### 4.3 @mozilla/readability

| 属性 | 值 |
|------|-----|
| 版本 | 0.6.0 |
| 描述 | A standalone version of the readability library used for Firefox Reader View |
| 仓库 | github.com/mozilla/readability |
| 输出格式 | 提取后的 HTML（需要二次转换） |
| 特点 | 自动去除广告、导航、页脚等非正文内容；Firefox Reader View 使用的同款 |

**注意**: readability 输出的是净化后的 HTML，不是纯文本或 Markdown。需要配合 turndown 或其他库做二次转换。

### 4.4 cheerio

| 属性 | 值 |
|------|-----|
| 版本 | 1.2.0 |
| 描述 | The fast, flexible & elegant library for parsing and manipulating HTML and XML |
| 仓库 | github.com/cheeriojs/cheerio |
| 输出格式 | DOM API（jQuery 风格） |
| 特点 | 不是转换库，是解析库。适合精确提取特定元素 |

### 4.5 linkedom

| 属性 | 值 |
|------|-----|
| 版本 | 0.18.12 |
| 描述 | A triple-linked lists based DOM implementation |
| 特点 | 轻量级 DOM 实现；readability 需要 DOM 环境时可用 |

---

## 5. 关键设计决策分析

### 5.1 纯文本 vs Markdown — AI Agent 场景推荐 Markdown

**Claude Code 的选择: Markdown**

理由：
1. **保留结构**: 标题层级、代码块、链接、列表在 Markdown 中都有明确语法
2. **LLM 原生理解**: 所有主流 LLM 训练数据中大量包含 Markdown，理解能力强
3. **信息密度**: 比纯文本高（保留了格式语义），比 HTML 低（去除了标签冗余）
4. **上下文效率**: 同样的内容，Markdown 比 HTML 节省 30-50% token

### 5.2 是否需要 Readability 提取正文？

**Claude Code 的选择: 不使用 Readability，用 Turndown 全量转换 + Haiku 摘要**

分析：
- Readability 的优势在于去除广告/导航等噪音，但对于 AI Agent 场景，Haiku 小模型做二次处理效果更灵活
- Readability 有误判风险（可能把重要侧栏信息当噪音删除）
- Claude Code 通过 `prompt` 参数让 Haiku 按需提取，比 Readability 的"一刀切"更精准

**替代方案**: 如果不想用小模型做二次处理，`Readability + Turndown` 组合是最佳选择：
```
HTML → Readability(提取正文 HTML) → Turndown(转 Markdown) → 返回给 Agent
```

### 5.3 超大页面截断策略

**Claude Code 的策略: 字符截断 100K + 追加提示**

```typescript
const truncatedContent = markdownContent.length > MAX_MARKDOWN_LENGTH
  ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated due to length...]'
  : markdownContent
```

**Anthropic API 服务端的策略: Token 限制**

```typescript
max_content_tokens?: number | null; // 按 token 数限制
```

---

## 6. OpenHorn 现有状态

在 OpenHorn 源代码中（排除 node_modules），**没有找到** WebFetch、Turndown、Readability 或相关 HTML 转换库的任何引用。这是一个全新实现。

---

## 7. 推荐的技术栈组合

根据调研，适合 AI Agent 的 WebFetch 实现有两种路线：

### 路线 A: 简单路线（不用小模型摘要）

```
fetch(url) → HTML/响应
  ↓
@mozilla/readability → 提取正文 HTML（去广告/导航）
  ↓  
turndown → 转 Markdown
  ↓
字符截断（100K 或按 token 限制）
  ↓
直接返回 Markdown 给 Agent
```

依赖: `@mozilla/readability` + `linkedom`(提供 DOM) + `turndown`

### 路线 B: Claude Code 路线（带小模型摘要）

```
fetch(url) → HTML/响应
  ↓
turndown → 全量转 Markdown（不做正文提取）
  ↓
字符截断（100K）
  ↓
小模型(Haiku) + 用户 prompt → 按需摘要/提取
  ↓
返回摘要结果给 Agent
```

依赖: `turndown` + Haiku API 调用

### 路线 C: 使用 Anthropic API 服务端工具

```
在 messages.create() 的 tools 中传入:
{ type: 'web_fetch_20260309', name: 'web_fetch', ... }

服务端自动处理 fetch + 转换 + 截断，返回 DocumentBlock
```

依赖: 无额外依赖，但仅限 Anthropic 模型
