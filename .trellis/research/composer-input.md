# 聊天输入框高度与光标（2026-11-11）

## 已验证的修复

- `DesktopComposer` 旧实现始终隐藏原生正文，由 div 显示文本；可见正文与原生光标分别排版。现改为普通文本和 IME composition 使用原生文字，仅斜杠命令需要着色时启用覆盖层；覆盖层与输入框统一换行、连字设置和实际可用宽度，保留小数像素。
- 旧输入框仅有 min/max-height，未根据内容调整高度。`useComposerTextarea` 按 scrollHeight 调整：会话输入 36–160px、欢迎页 72–200px。清空/受控值变化/宽度变化/字体就绪时重测。
- 超过高度上限时测量当前插入点所在行并滚动输入框，不修改原生 selection，不强制跳到末尾。测量包括后缀，避免在词中编辑时改变断行。支持反向选区的活动端。
- 不改全局 Textarea，不新增产品按钮，不发送真实消息或连接真实 DB 做测试。

## 验证与边界

- `node apps/desktop/scripts/composer-input.browser.mjs`：13 类隔离 Chromium 回归通过，覆盖中英混排、自动增高、上限、末尾滚动、中间编辑、缩回、尾部换行、宽度变化、斜杠覆盖宽度、合成 composition 状态与欢迎输入框。
- desktop：694 pass / 0 fail；桌面类型检查、全仓 Biome check 通过；macOS debug app 构建成功。
- 回归截图：`/tmp/openhorn-composer-evidence/input.png`（临时文件，不作持久证据）。
- CUA 首次观察到原生会话输入框为空，随后所有应用窗口访问均返回 `cgWindowNotFound`，重连无效。未执行退出/重启，也未改动用户草稿；新 bundle 已生成，但当前旧进程尚未加载。原生 macOS 中文输入法候选与光标仍需重启后实测，合成 composition 事件不能替代该验收。
