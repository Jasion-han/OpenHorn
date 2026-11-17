# 附件文件格式测试记录（2026-11-05）

使用 34 个合成文件样例，对发送前附件和消息附件分别执行检查，共 68 组格式检查；另有 6 类虚拟长会话定位检查。文件原件由 Pillow、Office 文档库、pypdf 和 FFmpeg 生成，不使用用户资料、不发送聊天消息。

最终浏览器组件检查 68/68 通过；定位检查 6/6 通过。HTTP 上传仅有 11 个样例接收，23 个被现有格式白名单拒绝；这两种结果必须分别解释，不能把“预览通过”说成“所有格式可正常上传”。

## 覆盖与结论

| 类别 | 样例 | 观察结果 |
|---|---|---|
| 文本/代码 | UTF-8 中文、带 BOM 的 UTF-16、TS、JSON、CSV、YAML、HTML | 原文一致；HTML 按文本显示 |
| Markdown | 标题、粗体、列表 | 排版正常 |
| 图片 | PNG/JPEG/WebP/BMP/GIF/SVG、通用 MIME PNG | 图像解码正常 |
| 相机/扫描图片 | HEIC/TIFF | Chromium 内置解码失败时显示提示；系统打开入口及原件传递正常 |
| PDF | 可搜索的两页 PDF | 实际 canvas 为 400×300；加载正常 |
| 音频 | WAV/MP3/M4A/FLAC/OGG | 静音条件下播放推进、暂停及 seeked 事件均通过 |
| 视频 | H.264 MP4/MOV、VP9 WebM | 解码宽度 320，播放推进、暂停及定位通过 |
| Office | 有效 DOCX/XLSX/PPTX | 当前内置只显示文件信息；系统打开 IPC 调用、传递字节哈希正确，未实点验证 WPS |
| 压缩包 | 有效 ZIP | 显示文件信息，暂无内容预览或直接系统打开入口 |
| 异常 | 密码 PDF、损坏 PNG/PDF/MP4 | 明确显示无法预览提示，仍保留可选原件操作 |

## 本轮修复

- UTF-16 文本被固定按 UTF-8 解码，导致乱码。`readPreviewText` 现在按 BOM 识别 UTF-16LE/BE；保留 UTF-8 默认及大文本截断行为，导出/打开仍使用原始字节。
- HEIC/HEIF/TIF/TIFF 缺少扩展名识别和默认应用打开白名单。已在前端分类、MIME 回退和 Rust 系统打开入口中补齐。

## 现有入口限制

文件选择器 `ACCEPT_FILES` 与服务端 `ALLOWED_MIME_TYPES` 目前只包含 PNG、JPEG、WebP、PDF、TXT、Markdown 六类。JSON、代码、音视频、Office、ZIP 等在本地预览组件里可以被处理或显示文件信息，但 Chat 上传接口会返回 400 Unsupported file type。本次没有扩展这项服务端准入策略。

对应入口：`apps/desktop/src/components/chat/DesktopComposer.tsx`、`apps/server/src/services/attachmentService.ts`。

实际接收的 11 个样例通过原件 GET 回读，SHA-256 与上传前一致。未被接收的格式，消息预览用隔离测试文件源验证，不能据此认定数据库持久化/重启后可读。

## 定位与验证范围

UTF-16、PNG、TIFF、PDF、MP4、DOCX 六类附件均在真正的 TanStack 虚拟列表中检查：点击位置 300px → 打开 300px → 关闭 300px。测试准备阶段用虚拟列表 API 等待初始测量；开关断言只被动观察，不帮产品修正滚动。

格式结果来自普通矩阵运行，定位结果来自后续 `--scroll-only` 运行；原始结果合并保留在 [attachment-format-validation.results.json](attachment-format-validation.results.json)。

604 个桌面 Bun 测试、49 个 Rust 测试、全仓类型检查通过；修复版已完成 Tauri debug 打包。

本轮原生桌面补测未完成：Computer Use 多次返回 `cgWindowNotFound`；已尝试重启项目实例并重新绑定，后台进程已启动，但无法读取窗口。因此没有把不同格式在 WKWebView 或实际系统应用中的打开算为通过。Playwright WebKit 未安装；AVIF 样例生成器不可用，未覆盖。

## 复现

```sh
python3 apps/desktop/scripts/generate-attachment-fixtures.py
node apps/desktop/scripts/attachment-matrix.browser.mjs <生成的样例目录>
node apps/desktop/scripts/attachment-matrix.browser.mjs <生成的样例目录> --scroll-only
node apps/desktop/scripts/attachment-scroll.browser.mjs
```

上传检查会启动独立临时数据库和 loopback Hono 服务，不访问正常应用数据库或模型。原生调用在浏览器中由 IPC 记录器捕获，操作字节与原文件做哈希核对。
