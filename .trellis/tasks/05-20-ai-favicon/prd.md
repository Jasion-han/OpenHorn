# AI 回复参考来源链接渲染 — favicon + 可点击蓝色链接

## Goal

AI 回复中的 markdown 链接（`[text](url)` 格式）渲染为带 favicon 图标 + 蓝色可点击链接，点击跳转到目标地址。参照 Claude Code 桌面端的样式：行内展示，favicon 在前，蓝色链接文字。

## Requirements

### 1. Markdown 链接渲染增强
- `[NASA Demo-2](https://...)` 渲染为：🌐图标 + 蓝色"NASA Demo-2"文字
- favicon 从 Google Favicon API 获取：`https://www.google.com/s2/favicons?sz=16&domain={domain}`
- favicon 加载失败时显示默认 🌐 图标
- 点击链接在外部浏览器打开（Tauri 的 `target="_blank"`）

### 2. 样式要求（参照截图）
- 链接文字蓝色（`text-blue-600`）
- favicon 16x16px，与文字垂直居中
- 行内展示（inline），不独占一行
- hover 时有下划线

### 3. 不改动的部分
- DesktopCitationList 组件保持不变（那是折叠的参考来源区域）
- 纯 URL 文本（非 markdown 链接）不特殊处理

## Technical Approach

修改 `DesktopMarkdownMessage.tsx` 的 `components.a` 自定义渲染器：
- 解析 href 获取 domain
- 用 Google Favicon API 获取 favicon
- 渲染为 `<a>` 标签前加 `<img>` favicon

## Acceptance Criteria

- [ ] markdown 链接显示 favicon + 蓝色文字
- [ ] 点击链接跳转到目标地址
- [ ] favicon 加载失败时显示默认图标
- [ ] 样式与截图一致（行内、蓝色、favicon 在前）

## Out of Scope

- 纯文本 URL 自动识别为链接
- favicon 缓存到本地
- DesktopCitationList 改造
