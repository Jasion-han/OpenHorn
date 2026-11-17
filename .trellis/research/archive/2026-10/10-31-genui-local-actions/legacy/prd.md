# 生成式 UI：本地可算的交互不经 AI，提示词与示例纠偏

## Goal

实机测试中，gpt-5.4-nano 生成的房贷计算器把「切换为等额本金」做成了 `@ToAssistant` 按钮（点击后把文字放进输入框，
要再走一轮 AI），而这类切换完全可以用组件状态在本地完成。同时模型把派生值写成 `$x = 表达式`，导致结果显示 ¥0、
文本里出现 `[object Object]`。通过提示词规则与示例纠正模型写法；交互策略本身不变。

## Decision (ADR-lite)

* 能由已有数据算出的切换 / 筛选 / 展开 / 排序：必须用 `$state` + `@Set`（或 Toggle 等）在组件内完成，零延迟、不花 token。
* `@ToAssistant` 只用于需要 AI 生成新内容的请求；点击后**仍只放入输入框**（追加到草稿），不自动发送 ——
  按钮文字与实际发出的文字可能不一致，且每次发送有成本；html-ui 沙箱同理且必须保持。

## Requirements

1. `apps/desktop/src/lib/genui/promptText.ts` 的 OPENUI_RULES 增加规则：
   * 本地可计算的视图切换必须用状态 + `@Set`，禁止为此使用 `@ToAssistant`；`@ToAssistant` 只用于需要模型新内容的追问。
   * 只有用户可改的输入值用 `$` 声明（且初值必须是字面量）；派生值用不带 `$` 的普通名字（`monthly = @Payment(...)`），
     并给出错/对对照。
   * 用条件表达式（三元或库内等价写法）在两种模式间切换计算结果。以 OpenUI Lang 1.0 实际支持的语法为准。
2. OPENUI_EXAMPLES：把房贷示例换成带「等额本息 / 等额本金」`SegmentedControl` 切换的版本（月供 / 首月 / 总利息随模式变化），
   保留一个按需追问的 `@ToAssistant` 按钮作为对照（例如「结合我的收入评估压力」这类需要模型的内容）。
   示例必须通过现有 `prompt.test.ts` 的解析测试（无 errors / unresolved / orphaned，只调用存在的函数）。
3. HTML_UI_SECTION 若有相同问题（本地可做的事去调 sendPrompt），同步一句规则。
4. 调查 `$x = 表达式`：OpenUI parser 是否会对「状态初值不是字面量」报错。如果解析器不报，在
   GenUiBlock 的校验路径（已有的 meta.errors / 降级提示）里能否低成本识别并提示；如果需要侵入 lang-core 或做字符串替换
   之类的 hack，则不做，只靠提示词。结论写进 spec。
5. 提示词总长度仍需 < 32000（已有测试）。

## Acceptance Criteria

* [ ] 新规则与示例在 `buildGenUiSystemPrompt()` 输出中出现
* [ ] 新示例通过解析测试；新增一个测试：示例里存在 `SegmentedControl` 绑定的 `$` 状态，且没有 `$名字 = ` 非字面量初值
* [ ] desktop bun test / tsc / biome 通过
* [ ] 实机：用 gpt-5.4-nano 重新生成房贷计算器，模式切换在回答内直接生效，不再进输入框

## Out of Scope

* 改变 `@ToAssistant` / `sendPrompt` 的投递方式（仍只放输入框）
* 修改 `@openuidev/lang-core`

## 追加（实机后）：派生 `$` 状态自动修复

实机：gpt-5.4-nano 在新规则下已把「等额本息/等额本金」做成本地 SegmentedControl（✅ 切换在回答内生效），
但仍把派生值写成 `$x = 表达式`，结果值空白。真实输出存于 `nano-mortgage.openui`。仅靠提示词不够，增加确定性修复：

* 渲染前（仅在块完成、非 streaming 时）用解析结果 `stateDeclarations` + `computedStateNames` 找出初值为表达式的 `$name`，
  在源码中把这些 `$name` 引用改写为普通名字 `name`（只改字符串字面量之外的 token，`$name` 后不能紧跟标识符字符；
  若 `name` 已被普通语句占用则换一个不冲突的名字）。改写后的程序交给 Renderer。
* 修复成功且无其他错误时不显示「部分交互内容无法显示」；仍有其他错误（例如不支持的 lambda）照常显示。
* 不改 lang-core，不改模型原文存储；block state 的 key 不变。
* 测试：用 `nano-mortgage.openui` 作为 fixture，修复后 `$months`/`$monthlyPaymentA` 等不再在 stateDeclarations 中为表达式，
  关键派生值可计算出非空数值（若能用 lang-core evaluate 验证则验证）；以及字符串里出现 `$name` 不被改写、前缀相同的名字
  （`$r` vs `$rate`）不误改、与已有普通名字冲突时改名。
