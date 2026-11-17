# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

### Convention: slash 命令 token 的识别规则只有一份

**What**: `/name` token 的边界判定与识别（面板触发、发送解析、气泡 chip、输入框蓝色高亮、编辑重发）一律调用 `apps/desktop/src/lib/slashToken.ts` 的 `findKnownSlashToken` / `findSlashTokenAtCursor` / `stripSlashToken`，禁止在组件内重新实现正则。token 边界定义：`/` 位于文本开头或任意空白之后，token 为到下一个空白为止的 `\S+`。

**Why**: 2026-07-03 之前该规则散落三处（行首正则各写各的），导致"高亮认、发送不认"（builtin 的 name/id 口径不一致）这类漂移 bug。helper 是纯函数，测试在 `slashToken.test.ts`。

**Related gotchas**:
- 面板选择的就地替换必须在选择时用**最新** input 重新验证记录的 token 区间，失效则从光标重推导，兜底只关面板不动文本——直接用陈旧区间或"整段替换"兜底会吃掉用户文字
- builtin 命令识别必须 name 与 id 双匹配，且与高亮口径一致
- 列表滚动会让条目滑到静止指针下触发合成 mouseEnter/mousemove 抢走键盘选中；hover 更新索引必须做指针坐标门控（见 DesktopComposer `slashPointerRef`）


### Convention: 用户消息中的网页链接

- 用户消息由 `DesktopUserMessageContent` 按原始文本切片渲染 HTTP(S) 链接，保持换行、原文复制和既有 slash chip；存储内容不变，不将整个用户正文解释成 Markdown/HTML。历史消息使用同一入口。
- 普通单击在右侧网页预览打开；Cmd/Ctrl 单击或链接菜单可在浏览器打开，菜单可复制链接。文字选择不得触发打开；键盘可使用链接和菜单。
- 消息显示不触发网址、favicon 或网页元数据请求，页面仅在明确交互后加载。
- 用户链接和附件共用视口相对锚点，关闭预览返回各自点击来源；新发送/重试或切换会话取消旧来源，关闭标签不得重新激活已取消的锚点。
- 边界与交互回归见 `userMessageLinks.test.ts`、`previewPanelStore.test.ts`、`user-message-links.browser.mjs` 和 `attachment-scroll.browser.mjs`。

### Convention: 回复中的本地文件路径

- `DesktopMarkdownMessage` 中独立的行内代码路径可点击，保留代码外观和原始消息；支持绝对路径、`~/` 与本机 `file://`，不把命令、网页链接或代码块变成文件操作。
- 文件默认在右侧预览，文件夹在文件管理器打开；提供打开原文件、在 Finder 中显示和复制路径，不要求另存为。每次点击（包括已打开的同一路径）重新检查当前文件；删除、移动或权限错误必须明确显示，不创建文件或用历史模型文本冒充文件。
- 本地预览复用附件查看器与聊天来源锚点，关闭、收起和调宽保持点击位置；窄窗口使用弹窗。路径与消息内出现序号组成稳定来源，不能依赖会随渲染器重建变化的组件 ID。
- 原文件访问仅经主 webview 的 `local_path` 原生命令，限制为常规文件和最多 20 MiB 的字节读取；更大文件仍可安全地打开原文件。沿用默认应用扩展名限制，应用包只定位不启动；不改变 Sidecar 工作区权限或开放远程预览 webview 的文件访问。
- 回归入口：`localPathReference.test.ts`、Rust `local_path` 测试、`previewPanelStore.test.ts` 与 `local-path-links.browser.mjs`。2026-11-06 的 macOS 历史会话实测覆盖已删除文件提示；原文件读取等由原生测试与浏览器 IPC 测试覆盖。

### Convention: 搜索、通用设置与导出反馈

- 侧栏消息搜索必须丢弃旧关键词和已清空搜索的迟到结果，并分别显示等待、失败/重试、空结果。尚未实现的资料库标明不可用，不能用成功通知代替功能。
- 没有真实更新接口的账户信息只读，不保留能输入却不能保存的假表单。自定义指令由 `generalSettingsStore` 暂存在当前登录内存中；切页和重连保留脏草稿，账号变化/重启清除，首次加载失败时禁止把未知值当空配置覆盖。
- 自定义指令保存固定输入快照并防止重复提交，失败明确说明尚未生效并保留修改；迟到加载不能覆盖已保存内容。取消有改动时确认放弃，临时保存范围需在界面说明。
- `save_attachment` 返回 `Some(实际路径)` 或取消时 `None`，只有成功写文件后才返回路径。DTI 导出使用原生文件保存窗口，取消不得报告成功，同一次确认完成后不得因双击再次保存；离开导出页后迟到估算/数据不得重新打开窗口。完整备份仍使用目录选择流程，DTI 估算只描述会话/消息，不能借用备份大小冒充 JSON 大小。
- 验证入口：`generalSettingsStore.test.ts`、`settings-clarity.browser.mjs`；2026-11-09 原生只读账户、空搜索及 DTI 保存窗口取消验收通过，未修改真实自定义指令或写出真实导出文件。

### Convention: 配置探测与文件导入

- MCP 配置必须是对象；名称、类型或配置发生变化时，清理对应的连接测试结果。探测完成只可写回同一配置指纹和请求身份，不能用旧配置的绿标说明新配置可用。
- 文件导入显示所选路径，同一次确认防重复提交；离页后迟到的识别/结果不得打开旧弹窗。核心导入成功后异步刷新相关资源列表，不启动模型或定时执行；部分成功/缺失项使用待处理提示，不能混同全部成功。
- 对应行为覆盖在 `settings-clarity.browser.mjs`；容器/API与完整回归记录见 `docs/2026-11-09_systematic-OpenHorn-audit.md`。

### Convention: 侧栏历史与高亮加载的性能边界

- 普通会话日期组由 `SidebarConversationGroups` 使用稳定会话/组ID虚拟化；项目保留原有分页，搜索面向全部数据。聚焦、菜单打开和编辑中的行必须保留，不能因滚动而卸载；方向键与Home/End能到达未挂载行。祖先项目展开后要重测列表滚动偏移。
- `DesktopMarkdownMessage` 的Prism/主题与工作区文件预览按需载入，复用加载结果；等待高亮时保留完整原文、复制、行号和同等行高。不得因代码着色模块延迟而挂起整个回复、丢失交互页面状态或阻止复制。
- 性能数字使用生产构建、限定视口、固定数据与CPU条件、重复样本；首次可用在组件挂载后记录，不能将定位器扫描DOM时间算作渲染时间。浏览器界面数字不能称为完整原生进程/Sidecar冷启动。基准入口为 `scripts/performance.browser.mjs`，方法与范围见 `docs/2026-11-09_desktop-performance.md`。

### Convention: 历史记录与本机检测恢复

- 导入历史加载失败提供明确重试，保留缓存内容；删除记录前说明仅删除记录、不会撤销已导入数据。删除进行中阻止重复请求，失败保留记录和重试入口，不用“导入失败”描述删除错误。
- 外部编辑器仅缓存成功检测30秒，并发检测共享请求；失败可立即重试且保留上次成功结果和选择。通用设置提供显式重新检测，绕过成功缓存，不能把一次失败缓存到应用重启。

### Convention: 搜索来源与连接验证

- 联网搜索使用单一来源选择器和持续可见的服务端“当前搜索源”；来源草稿不代表已启用。Tavily、DeepSeek原生联网、OpenRouter联网、DeepSeek搜索接口和DuckDuckGo是同级搜索源，普通模型渠道不是搜索能力证明，不再列出任意聊天渠道供DeepSeek搜索选择。
- DeepSeek搜索接口默认仅填Key，中转地址按需展开；不出现模型或平台分类字段。独立原生联网显示固定官方接口及Pro检索模型，支持单独官方Key或合格官方渠道。旧搜索接口渠道引用可验证或改为手填，不复制已有渠道Key到表单。改地址清旧Key；保存配置和验证启用分开，保存不会切换来源或替换旧连接。
- 表单和revision必须从`/settings/search-configuration`同一快照加载；不能并行读取配置和search-status再拼接。可提交的activationRevision仅随表单saved基线更新，跳过表单应用的迟到刷新不得更新该revision。只有显式验证成功才更新当前来源；失败保留草稿和原来源。旧版/不完整状态响应使表单只读并给重试入口，不能崩溃或调用旧的自动激活保存语义。
- 真实收费验证仅由用户主动触发；自动化测试使用合成Key与受控响应。验证中禁重复操作；重连不覆盖脏草稿，账号/后端变化隔离会话状态。原生联网没有独立覆盖开关；显示实际检索模型/官方接口及手填Key或渠道Key来源，当前回答模型不变。旧后端缺Native能力标记时界面只读，并提示更新后重试。
- OpenRouter仅需独立搜索Key，新连接默认Flash，显示已保存的实际DeepSeek检索模型（旧Pro不得误标为Flash），修改Key保留该连接模型；同时显示Exa引擎和官方地址，明确与Jev/聊天Key分开；不借普通聊天渠道。专用保存API与`openRouterSearchAvailable`能力缺失时禁止新来源写入/启用。候选保存、失败草稿、取消恢复、重连与revision绑定沿用统一表单契约。实现、真实验证启用及最终原生证据见`docs/audits/2026-11-16/openrouter-search/validation.json`。
- 用户要求减少重复，但明确原有Tavily也必须保留：主列表合并`configuredProviders`与已验证目录并去重，不能因缺少新验证记录隐藏已有连接，也不把Tavily与OpenRouter合并。缺验证记录显示“待验证”；旧后端缺配置目录时按已保存表单保留已有连接，不编造验证状态。DeepSeek两协议优先当前项，再优先已验证项；真正未配置类型仍放显式配置入口。当前已启用且无待验证修改时禁重复验证并显示“已启用”。修复及两连接原生证据见`docs/audits/2026-11-16/tavily-restore/validation.json`。
- 前置检索Stop发送带用户会话nonce的取消请求，不直接丢弃准备HTTP响应；停止检索后获取并保存问题/停止回复的真实ID。准备完成前保留前台所有权，避免晚旧问题插到新问题之后。编辑/重试取消信号贯穿服务端检索；回答模型空引用不能抹掉准备阶段引用。
- 上传前即登记Stop与所有权等待；已停止准备明确传递`stoppedBeforeStart`。停止后上传失败保留问题和附件元数据，提示上传未确认；取消请求失败即使迟于准备响应也显示未确认停止，不能吞掉失败或声称文件已经上传。
- 受控Radix Select的根value始终保持字符串，未选择用`""`，不能用`undefined`变为非受控；SelectItem不使用空字符串值。菜单默认、hover、选中及键盘聚焦态保持浅色。
- 浏览器使用的纯设置常量从`shared/search-settings`导入；`shared/search`包含Node传输依赖，不能因取一个常量把它带入桌面bundle。
- 验证入口：`deepseek-capabilities.browser.mjs`、`genui-chat-failure.browser.mjs`、`searchSettingsService.test.ts`、`sidecarRunSupport.search.test.ts`。当前独立原生来源证据见`docs/audits/2026-11-15/independent-native-search/validation.json`，2026-11-16已完成最终原生重启及表单/取消草稿操作；原生独立hover未留帧、由浏览器夹具覆盖，不做真实Key收费探测。此前三来源桌面验证记录在`docs/audits/2026-11-15/search-source-clarity/validation.json`。

- Agent搜索步骤的来源由运行时生成的`SearchExecutionSource`标记，随调用经过WS/投影/store并持久化；预览和展开行显示Search · Tavily/OpenRouter等实际来源，Tavily→DuckDuckGo降级明确标识。结果按toolCallId同步开始行，早开始合并不能丢来源；不能拿当前设置或模型正文重标旧记录，缺元数据仍显示通用Search。MCP名和Fetch保持独立含义，不把网页读取误作搜索源切换。
