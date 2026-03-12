# Backend Connectivity Banner Design

**Problem**
当 `server`（`http://localhost:3000`）不可用时，Web 端会出现以下误导性体验：

- Settings/Chat/Agent 等页面请求失败后会刷屏式弹出 `Failed to fetch`。
- 页面内容因为请求失败看起来像“配置丢了”，用户难以判断是后端挂了还是数据被清空。

**Goals**
- 后端不可用时，在 Header 区域常驻展示明确的离线状态，并提供 `Retry`。
- 网络类错误 toast 自动去重，避免刷屏。
- 后端恢复后，执行“软刷新”：自动重新拉取当前页面所需数据，不做整页 reload（避免清空输入框）。

**Non-goals**
- 不引入复杂的全局请求重试策略（不做指数退避队列）。
- 不把所有业务错误都统一成 banner（仅处理“后端不可达”这类连接问题）。

## UX

**离线状态**
- Header 常驻一个红色 `Badge/Alert`，文案类似：`Backend Offline` / `后端不可用`。
- 右侧提供 `Retry` 按钮。
- 离线状态下仍允许用户浏览现有 UI，但所有 API 调用会失败且不会刷屏。

**恢复在线**
- 点击 `Retry` 成功后：
  - 离线提示消失或变为绿色短暂 `Online` 提示（可选）。
  - 触发“软刷新”事件，让当前页面重新拉取数据。
  - 弹一条低噪音 toast：`连接已恢复`（去重）。

**toast 去重**
- 对网络不可达类错误（典型：`TypeError: Failed to fetch`）：
  - 只在一定时间窗口内弹一次（例如 10 秒），并复用固定 key（例如 `backend_down`）。
  - 后续重复错误只更新全局状态，不再重复弹通知。

## Architecture

**全局后端状态**
- Web 增加一个全局状态模块（推荐用 Zustand store，风格与现有 store 一致）。
- 状态字段：
  - `status: 'unknown' | 'ok' | 'down'`
  - `lastError?: string`
  - `lastDownAt?: number`
  - `lastUpAt?: number`
- 行为：
  - `markDown(errorMessage)`
  - `markUp()`
  - `retry(): Promise<boolean>`（内部调用 health check）
  - `emitRecovered()`（触发软刷新事件）

**Health Check**
- 直接复用 server 现有 `GET /`（返回 `{ message, version }`），无需登录态。
- 前端 `retry` 调用 `fetch('http://localhost:3000/')`，成功即视为在线。

**软刷新事件**
- 使用 `window.dispatchEvent(new CustomEvent('openhorn:backend-up'))`。
- 需要自动恢复的页面组件在 `useEffect` 中监听该事件并调用它们已有的加载函数：
  - `AuthBootstrap`: 重新拉取 `me + channels`（保证 Header 默认模型/登录态同步）
  - `ChannelSettings`: `loadChannels()`
  - `AgentSettings`: `loadAll()`
  - `ChatAside`: `loadConversations()`
  - `Agent page`: 重新拉取 sessions/workspaces/settings（若已有加载函数则复用）

**错误分类**
- 在 `fetchApi` 里区分两类失败：
  - “网络失败/后端不可达”：`fetch()` 抛错（常见 `TypeError`），标记 `down`，toast 去重。
  - “HTTP 响应错误”：能拿到 response（包括 401/400/500），标记 `ok`，并按现有逻辑抛业务错误信息。

## Testing / Verification

**手动验证**
- 停掉 server（3000）：
  - 页面出现 Header 离线提示。
  - 只弹出 1 条 `Failed to fetch` 相关 toast（不刷屏）。
  - Settings 不再让用户误以为“配置丢失”（离线提示非常明显）。
- 恢复 server：
  - 点击 `Retry`，离线提示消失。
  - 页面自动重新拉取数据（channels/workspaces/sessions 等）。
  - Chat/Agent 输入框内容不被清空（无整页 reload）。

