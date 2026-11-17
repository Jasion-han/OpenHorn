# tauri dev 实机验证结果（2026-10-31）

按 `archive/2026-10/10-31-ui-html/tauri-verification.md` 逐项在 `pnpm dev:desktop`（WKWebView）里操作，
截图 + CGEvent 鼠标 + AppleScript 键盘驱动。

## 修复前

- html-ui 块是空白框（只有边框，320px 初始高度不变）。`desktop.log` 有
  `No application knows how to open URL about:srcdoc` ×4 —— `on_navigation` 取消了子 frame 的 srcdoc 加载并交给了 `open`。

## 修复后

| 项 | 结果 |
|---|---|
| parent.document | blocked ✅ |
| localStorage | blocked ✅ |
| `__TAURI__` / `__TAURI_INTERNALS__` | undefined / undefined ✅ |
| ipc / webkit.messageHandlers | undefined / object（预期）✅ |
| origin | null ✅ |
| fetch | blocked ✅ |
| 加载时自动 sendPrompt | 输入框为空 ✅ |
| 点「追问」 | 输入框出现「沙箱追问」，未自动发送 ✅ |
| 沙箱 `location.href = "https://example.com/?openhorn-nav-probe"` | frame 原地不动；Chrome / Safari 均无该 URL 的标签页，无新进程 ✅ |
| html-ui 计算器：流式预览 + 完成后拖动滑块实时计算 | ✅（30 年 → 15 年，月供 4745 → 7372） |
| openui-lang 组件：拖动滑块 | ✅（30 年 → 10 年） |
| 切到设置再回来 / 完全退出应用再打开：滑块位置 | 保持 10 年 ✅ |
| 组件按钮 @ToAssistant，输入框已有草稿 | 追加到草稿之后，未发送 ✅ |
| 暗色模式：组件 / html-ui 沙箱 | 跟随变暗 ✅（模型自己写死浅色样式的 html-ui 页面除外） |
| 关闭 Interactive，新会话问同样问题 | 普通 Markdown，1.7k tokens（未注入）✅ |

## 追加发现

- **Claude Code（OAuth）渠道收不到系统提示**：模型自称「没有任何系统提示」「我是 Claude」，
  不知道 OpenHorn 的 agent 提示，也不知道 openui-lang，于是编造 YAML 写进 ````openui-lang。
  同一提示在 OpenRouter gpt-5.4-nano 上生效（19k tokens vs 1.9k）。不是本功能引入，记入 spec。
  该渠道 Chat 模式返回 429。
- `@openuidev/react-lang` 开发模式自动挂载 OpenUI Inspect 浮层 —— 已关闭。
- `Stat` 拿到对象值显示 `[object Object]` —— 已改为显示为空。
- gpt-5.4-nano 写 openui-lang 会犯枚举值错误（`Badge "primary"`、`Row justify "stretch"`）和把派生值写成 `$x = 表达式`；
  渲染器按设计降级（显示能解析的部分 +「部分交互内容无法显示」）。

## 未覆盖

- 「答案里的链接在应用内预览面板打开」：本轮没有出现带链接的回答，未单独测。
