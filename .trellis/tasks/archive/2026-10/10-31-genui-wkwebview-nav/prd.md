# 生成式 UI：WKWebView 下 html-ui 沙箱空白与导航外开

## Goal

tauri dev 实机验证时发现：```html-ui 块在桌面端是一块空白框（Chrome 下正常）。

## 根因

`apps/desktop/src-tauri/src/lib.rs` 主窗口的 `on_navigation` 只放行 `http(s)://localhost` 与 `tauri://`，
其余一律取消并用系统 `open` 打开。wry 对**所有 frame**（含子 frame）都调用这个处理器，
所以沙箱 iframe 的 `about:srcdoc` 加载被取消（框是空的），还会执行一次 `open about:srcdoc`。

连带的安全问题：沙箱脚本让自己的 frame 跳转（`location = "https://…"`、`file:`、自定义 URL scheme），
会被这里转交给 macOS `open` —— 无需用户点击就能打开浏览器、启动 URL scheme 对应的应用，绕过焦点门槛。

## Requirements

* 放行 `about:srcdoc`（子 frame 的 srcdoc 加载）。
* 非本地导航一律取消，**不再**在导航处理器里调用系统 `open`。主 frame 的外链点击由 `App.tsx` 的
  全局点击处理器经 shell 插件打开，不受影响。
* 判断逻辑抽成纯函数并加 Rust 单测。

## Acceptance Criteria

* [ ] 桌面端 html-ui 探针块正常显示，各项与 tauri-verification.md 期望一致
* [ ] 沙箱内 `location = "https://example.com"` 不会打开浏览器
* [ ] 回答里的普通外链点击仍在浏览器 / 预览面板打开
* [ ] `cargo test` 通过

## Out of Scope

* 区分主 frame / 子 frame（Tauri 的 on_navigation 只给 URL）。

## 实机验证中追加发现（同一任务一并修）

* `@openuidev/react-lang` 在 `NODE_ENV=development` 时会自动挂载 OpenUI Inspect 浮层（含厂商推广：Get API key、
  `npx @openuidev/cli deploy`），挡住界面。生产构建会被 DCE 掉，但开发时应关闭：在首次加载该库之前设置
  `globalThis[Symbol.for("openui.devtools.autoMount")] = true`（库自身的去重标志）。
* `Stat` 等展示组件拿到非标量值（模型把派生值写成 `$x = 表达式` 时）会渲染成 `[object Object]`；
  非 string/number 时应显示为空。
