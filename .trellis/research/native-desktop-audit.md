# 推送后原生验收交接（2026-11-14）

## 2026-11-15 用户纠正设置配色（优先于下文旧浅黄方案）

- 用户查看重启后的外观页截图，明确认为黄色选中态与原界面割裂，要求恢复之前效果；不要再把“浅色交互态”泛化为黄色品牌强调。
- 已撤回 `7b2ce8e` 在四处引入的黄色样式：SettingsView 导航选中态恢复 `bg-muted`、SettingsSegmentedControl 选中态恢复 `bg-background`、共享 Button 与 Switch 恢复原有主色 token。保留 `aria-current` / `aria-pressed` 和键盘焦点提示，焦点描边改为既有 `ring` token。本次不是删除所有表示状态的黄色，也未调整其他业务逻辑。
- desktop/ui 类型检查、四文件 Biome、diff whitespace 检查、UI/Tauri debug app 构建通过。原生退出旧实例后打开新包，真实截图确认外观页灰白选中态和两处键盘焦点描边；Agent 页看到共享开关恢复原样，渠道页看到主按钮恢复原样。最终窗口停在外观页；未修改账号、渠道或搜索配置。
- 用户随后要求提交，已先 pull --ff-only，再以 `dc820f0`（fix(ui): 恢复设置与共享控件原有配色）提交这四文件并普通推送 origin/main；ahead/behind=0/0，暂存区空。提交前全仓 `pnpm check` 检查870文件通过。其他既有 WIP 与混有旧内容的记忆文件保留在本地，未整批提交。
- 用户随后截图指出账户头像与 DeepSeek 保存按钮仍黄。此前仅恢复共享控件不够，局部 className 仍覆盖它们。补漏恢复 GeneralSettings 头像原有 `bg-primary/text-primary-foreground`，删除 DeepSeekToolSettings 菜单、选项、开关和保存按钮的黄色覆盖，复用共享样式。设置与共享组件中剩余 yellow 仅为默认渠道图钉的状态颜色，未将警告/默认状态指示视作装饰色删除。
- 补漏两文件的 desktop/ui 类型、Biome、UI/Tauri 构建通过。退出重开实际桌面，截图确认头像黑白、DeepSeek 保存按钮禁用灰色/启用主色、开关两态；真实展开搜索来源菜单并用方向键聚焦，菜单白底/浅灰聚焦。为查看启用态仅切换未保存 native 草稿后切回，最后仍 off、保存/取消禁用，未点击保存或改动实际配置；窗口停在 Agent 工具区域。补漏尚未提交，GeneralSettings 的其他既有编辑器检测 WIP 必须保留；以后提交仅取头像单行 hunk。

> 最新状态：确认放弃期间的提问/成果保存保护已修复并验证，见 `docs/2026-11-14_discard-submission-results.md`；提问弹窗视觉仍有观察限制，报告未记全绿。此前与本轮 QA 临时环境均已清理，下文路径仅作历史记录。

## 已确认结果

- 用户明确要求 ship-flow 后继续实际桌面逐项操作、发现问题后修复并复验。**整体原生验收仍未完成**，不能把构建或浏览器 fixture 算作已看到原生窗口。
- 前轮 DeepSeek 能力六批已推送至 `e49b921`；本轮五批已推送至 `5deaf8f`。origin/main 已经 ls-remote 确认。没有部署。
- 本轮发现并修复：Office/图片错误提供本地重建；导入错误缺少结构化可操作提示；非法 MCP 配置与特殊对象键；真实模型使用工作区绝对路径修改文件时没有生成 checkpoint。
- 隔离提交树：shared/adapters171、desktop674、sidecar344、server542，共1731项 Bun 测试全过；Rust52项通过；typecheck、Biome、UI build、host sidecar编译与独立 Tauri debug app 构建通过。
- 真实已配置 provider/编译 Sidecar完整七组通过，包括发送保存重载、SSE重试、旧准备409、流式停止、Agent明确授权后写文件及快照恢复。真实 HTTP六组通过，DOCX/PNG/文本上传下载SHA-256一致。不是 DeepSeek真实付费能力验收。
- macOS锁屏，曾观察到IOConsoleLocked/CGSSessionScreenIsLocked=Yes。CUA原应用与独立QA包均无法取得窗口，返回cgWindowNotFound。已发送一次time-sensitive“需要你处理”通知并确认触发，**不要重复催促或发送整体完成通知**。等待用户解锁，不能尝试绕过锁屏。
- 独立Bun1.3.10 HTTP探针发现部分6–8字节含NUL合成multipart文件被原生formData解析截短；真实文件通过，不声称修复任意二进制完整性。

## 续验入口

- 主要报告：`docs/2026-11-14_native-audit-results.md`；含代码结构、证据及35项待原生操作清单。
- 原目录 `/Users/han/Project/OpenHorn` 有大量用户原有 WIP，保留未提交。提交通过隔离候选树与index-only patches生成；之后将修复三方合回原文件，保留原有更完整的MCP校验等。原目录integration typecheck、desktop12项/server20项focused、Sidecar编译通过。不要清理或整体提交WIP。
- 隔离工作树：`/var/folders/2b/0vr77k3j1yv2m83zxdkpx48c0000gn/T/openhorn-ship-c_aqqrxq/verify`，分支`codex/native-audit-20261114`，候选末commit `6a0133a`与main `5deaf8f`树相同。
- 审计根指针：`/tmp/openhorn-current-ship-dir`。私有运行参数以其`native-runtime/runtime.json`为准；QA backend当前`http://127.0.0.1:59329`，有独立DB与上传目录，未复制用户历史。不要输出private-environment、DB或私有provider/事件日志。
- 独立QA应用：审计根`native-build/debug/bundle/macos/OpenHorn Native QA.app`，identifier=`com.openhorn.nativeqa`，本地未签名包，编译时指向QA backend。已通过CUA尝试打开但无可见窗口。原应用/3002后端没有重启或替换，旧进程不会自动变成新代码。
- 解锁后先读CUA文档并选取QA原生窗口，依报告逐项实做；发现问题再修复、编译和重验。涉及GUI删除等操作按工具确认要求处理。不要为重复确认锁屏而轮询。

## 用户返回后的实机续验（代码已推送，GUI还原待确认）

- 用户返回后macOS已解锁，实际打开独立Tauri QA应用完成多轮原生操作，最新报告为 `docs/2026-11-14_native-desktop-validation-results.md`，证据在 `docs/audits/2026-11-14/native-visible/`。46条按时间追加的观察组含有限观察、未完成和已确认问题，不是46项全绿测试。
- 六批已推送至main `dcea75c40c24931f2f7aae6ce250e3d1228e43c7`，ls-remote确认，ahead/behind=0/0。提交为81b0ebc、7b2ce8e、2f395d1、851b762、e75e28e、dcea75c。隔离候选分支当前db5e34c与main提交树完全相同，工作树干净。
- 修复：只读账户信息替代无效保存按钮；自定义指令加载/保存失败、重连草稿和过期请求保护；浅黄主操作与可访问选中态；导入后刷新资源、同步重复提交/迟到弹窗守卫、所选文件与完成按钮；仅所属会话的快照提示和内联二次确认，忙碌/过期目标保护。
- 实机已经看到通用设置失败提示、重连及切页草稿保留、重试成功和重启后读取；MCP null/数组拒绝及合法对象/禁用；Chat发送/编辑/重试/实际部分停止；资料库检索、带来源真实问答、图片重建禁用、OCR确认取消；原生项目文件夹选择、真实Agent读写及目录缺失拒绝；工作台成果保存查看、八类设置页、定时任务表单取消、一次损坏ZIP反馈及一次DeepSeek v3原生导入（1会话2消息）、CmdQ宿主与子进程退出。
- 最终内联确认已经由真实截图确认说明和两个按钮可见，保留当前文件后收起且文件未变；离开会话隐藏，统一搜索返回所属会话恢复。此前弹窗AX存在但截图不可靠，因此未以AX代替视觉验收；最终改为内联展示。
- 681项发布树桌面测试、typecheck、Biome和本地未签名Tauri构建通过。导入处理函数测试在已发布版本1pass/2fail，候选3pass/0fail。三方合回原工作区后711项桌面测试、typecheck、Biome通过；711包含原有未提交功能，不能替代发布树681。整合时269个无关WIP路径逐字节保留；其余未提交内容继续保留。
- 重复原生ZIP选择出现选中但Open禁用，未完成重复导入的GUI验收；取消扩展名筛选的本地QA对照同样失败，Rust已按原字节还原，未发布任何过滤器变更。不要再按猜测修改筛选器，也不要将服务端去重或处理函数测试算成原生重复导入通过。
- 未执行真实DeepSeek付费OCR/其他付费工具质量、实际中文输入法选字、自动调度运行、GUI删除和最终GUI还原。模型累计usage 27k/55k/41k仅是不同回合记录，未分解system/tools/skills/history，不能直接归因或宣称性能优化。

### 下一步具体动作

- 当前QA.app仍运行，最终会话标题“追加质检确认标记”。入口是其浅黄“还原文件快照”提示，可展开内联影响说明。不要重启QA应用或Sidecar后再假定旧快照仍有WebSocket归属。
- 专用 `native-runtime/workspace/qa.txt` 当前4行：NATIVE_QA_MARKER、NATIVE_DESKTOP_AGENT_OK、NATIVE_DESKTOP_CHECKPOINT_READY、NATIVE_INLINE_CONFIRM_READY。唯一待还原快照只覆盖qa.txt，恢复后为前三行。当前SHA256=`c2db6f60058dab6dc5a6d06a9ea315b8319053d66ce182221c8d8e80126d7d28`，恢复后=`b3f859ccf0bfb7839472b2f450c62e71e952963e916323049f80e9e8fd8a7cea`。完整runId/conversationId在`native-runtime/native-final-content-verification.json`及公开content-verification.json。
- 按桌面控制工具Computer Use Confirmations Policy，最终GUI覆盖/移除数据必须动作时确认。本轮尚未点击“确认还原文件”。用户同意后先核对文件仍为记录的当前哈希、选择同一QA会话，再实际点击、观察成功与文件恢复哈希。若用户已自行还原，只核实，不再次覆盖。
- 已于本轮发送一次新的time-sensitive“需要确认文件还原”通知，工具返回notificationTriggered=true、1人time-sensitive、无fallback。它与之前的锁屏通知是不同事件，均不要重复发送。整体原生验收仍未全部完成，不发送成功完成通知。
- 还需人工核对系统文件选择器的重复选择/可打开状态；下一轮可请用户手动完成一个明确的系统选择步骤，再继续观察导入结果，不伪装已通过。
- 原有应用/3002后端未替换；验收使用独立QA.app与runtime.json中的独立本机服务。原工作区main有大量保留WIP；不要reset/clean/整体stage或在脏目录rebase。


## 再次外出后的第二轮（待解锁复验，新增代码未提交）

- 本轮重新 fetch / pull --ff-only / 普通 push，main 与 origin/main 同步在 dcea75c；未新增提交。完整记录 `docs/2026-11-14_native-round2-results.md`，14条含失败/不确定性的原生观察在 `docs/audits/2026-11-14/native-round2/validation.json`。
- 原QA实例出现选择文件后Open禁用、部分重绘不可靠，随后CUA对该实例超时。只读检查当时未锁屏，进程采样不能证明挂起根因。保留原实例，另开复制的 OpenHorn Review（com.openhorn.review）对照：实际看到完整上传弹窗，选择生成notes.txt时Open启用，回到表单看到文件名和启用的导入；最终上传未执行。点击取消看到内联放弃确认，继续编辑保留文件。该对照不等于Tauri备份ZIP重入通过。临时Review已CmdQ退出。
- 实机发现上传表单显示英文Choose File，且放弃确认期间仍能导入。候选修复在LibraryUploadDialog：字典中文浅色按钮触发隐藏input，File草稿统一展示文件名，取消系统选择器不抹掉原File，重置原生input值支持同文件重选；discard期间禁用选择/取消/导入，submit handler再次守卫。新增LibraryUploadDialog.submit.test.ts。无依赖/权限/Rust/Sidecar变化。
- 新回归基线2pass/1fail，候选3pass/0fail；隔离树684pass/0fail、整合原工作区714pass/0fail，两树typecheck/Biome通过。新UI与Tauri debug app构建通过。原有273个WIP路径整合时逐字节保留。两个产品文件、计划、报告及证据已在原工作区和隔离verify；保持未提交、未推送，等待候选原生视觉验收。
- 候选新包：审计根native-build/debug/bundle/macos/OpenHorn Native Review.app，identifier com.openhorn.nativereview，编译时VITE_API_BASE=http://127.0.0.1:59329。当前宿主47402/sidecar47434（续跑时用ps核实，PID非稳定）。原QA宿主10143/sidecar10246继续保留，其待还原qa.txt当前哈希仍c2db6f60058dab6dc5a6d06a9ea315b8319053d66ce182221c8d8e80126d7d28。不要为候选验收重启原QA，快照WebSocket归属仍需保留。
- 构建后再尝试新包CUA返回cgWindowNotFound，只读检测IOConsoleLocked=Yes。已发送一次新的time-sensitive“桌面复验需要解锁”，notificationTriggered=true、1人time-sensitive，无fallback。不要重复催促/发送完成通知；不尝试绕过锁屏。
- 解锁后的具体顺序：新候选中文选择按钮→有效文件→重开选择器取消保留草稿→同文件重选→不支持类型错误→放弃确认禁用态→继续编辑恢复与键盘焦点。最终资料上传/原QA还原仍需各自动作时确认。之后才按ship-flow精确分批提交推送本轮新增文件，不能整体stage其余WIP。
- 源码复核新增部署边界：dataTransfer detect/import把桌面filePath发给server，server stat/read同一路径；远程后端不应算本地QA等价验收。远程受限上传/临时文件设计留后续，未擅自改接口。缩放快捷键的此次观察受菜单焦点影响，不作已确认缺陷。


## 用户再次继续后的原生复验与推送（上传动作待确认）

- 用户“继续”后桌面已解锁，真实打开候选OpenHorn Native Review，完成中文按钮→系统选择notes.txt→取消选择保留文件→同文件重选→不支持ZIP中文错误/导入禁用→放弃确认三项普通控件禁用→Enter继续编辑恢复。不是浏览器fixture或API替代。
- 实机发现候选“选择文件”可见标签与按钮重复，关联Label改sr-only；退出候选、重新构建并启动最终包，截图确认单一中文按钮、Tab/Shift+Tab聚焦环、有效文件名、最终包的放弃禁用态和Enter恢复。最终候选684/0桌面测试、typecheck/Biome、原生构建通过；原目录整合714/0是上一段整合测试，最终原目录Biome再次通过。未把两者数量混用。
- 已按ship-flow在main精确提交、普通推送：da752c6 fix(library):统一中文文件选择并阻止放弃确认期间提交；fb30ff2 docs(validation):记录解锁后的上传表单实机复验。先fetch/pull --ff-only确认基线，再分批提交推送，无强推/无部署。报告docs/2026-11-14_native-round2-results.md已更新，公开validation.json现28条含失败/不确定性的观察组，不能说28项全绿。
- 273个原有WIP路径除预期memory更新外保持不变；两个产品文件与验证候选及提交树一致。隔离verify仍停在db5e34c，含本轮已推送内容的工作区改动与新文件；不要再把它们当未发的新功能整体重提。
- 最终包仍运行，当前停在“导入资料”弹窗，个人资料，已选native-qa-notes.txt（100bytes，合成ORCHARD-42说明），普通导入按钮启用，尚未点击。目标为独立本机QA后端127.0.0.1:59329；点击会存原件并本地解析，不会调用DeepSeek OCR。下一步须取得这份文件向该目的地上传的具体确认，之后重新读取AX状态并核对所选文件再点击，观察结果与内容；不要把“继续”解锁续验当上传授权。
- 原QA的快照仍保留，qa.txt四行哈希仍c2db6f60058dab6dc5a6d06a9ea315b8319053d66ce182221c8d8e80126d7d28。最终还原继续待独立动作时确认；本轮未点击放弃修改/文件还原/上传/付费OCR。锁屏旧提醒已被用户回应，不能补发完成通知。
- 当前上传确认阻塞已发送一次time-sensitive“需要确认验收文件上传”，notificationTriggered=true，1人time-sensitive、无fallback；与旧锁屏/还原是不同动作，勿重复发送同一上传通知。main最终远端HEAD已ls-remote确认fb30ff232533f7a112ae9400b4ecb2c51ca3cef8，ahead/behind=0/0，index空。


## 细节补测与环境清理完成（2026-11-14）

- 用户在具体合成文本上传确认后表示“很好，继续”，原生点击导入后看到notes.txt已就绪、1片段、ORCHARD-42正文；同一文件重入仍仅一份。停止独立QA后端后原生提交看到中文失败且File保留，恢复同一服务后原生重试成功。项目范围不混入个人资料、全部范围导入禁用、带首尾空格检索命中正确来源。
- 此前卡住的原生ZIP重入这次已完整走通：系统Open可用，正确识别生成归档，实际确认后0会话导入/1跳过/0消息，并在历史记录本次0项。零字节与5242881字节文件均原生选择后被本地中文校验拦截、提交禁用，未上传。
- 实机发现原件已保存且待显式OCR被重复标红。LibraryView只对library_cloud_required省去重复红alert，保留状态与操作指引，不改服务端状态/OCR调用。重建并真正看到图片/Office提示正常；本机API预置无效UTF8后原生查看仍显示红色library_invalid_text，不能把预置当原生上传证据。候选684/0、typecheck/Biome、UI/Tauri构建通过，主目录Biome通过。原件下载100字节与源逐字节及SHA256一致。
- 两批已普通推送main：a3ba99b（待OCR反馈），ddf6160（细节实测与清理报告）。脱敏17组观察和清理清单位于docs/audits/2026-11-14/native-details/validation.json；不宣称全项目所有操作验收通过。
- 用户明确要求最后清理临时数据。先验证verify的20个脏路径均在主线保存、其基线树与dcea75c相同；退出/停止任务专用宿主Sidecar后端，删除隔离工作树与临时分支codex/native-audit-20261114。审计根openhorn-ship-c_aqqrxq清理前3789056KiB，已整体删除，含生成数据、独立DB/上传、私有环境、原始日志及本地构建；未保留秘密数据副本。三个QA应用标识的WebKit/缓存/偏好/日志和注册已清理，八个已知tmp记录已删除。
- ~/.openhorn/snapshots只删除manifest.workspaceRoot位于该审计根的单一bucket（三份生成快照），未全局清空。原qa.txt和待还原快照均随本次明确清理终止，不再请求旧还原或尝试打开旧包。原应用170/227和3002后端99476在清理时保持原进程身份，273个原有WIP路径除预期memory更新外字节不变；其他既有工作树（含旧prunable注册）未动。
- 原生最终快照覆盖、真实付费DeepSeek OCR质量/账单、真实IME候选选字和自动调度仍未验收；范围菜单展开画面不可靠，未声称配色验收。远程后端filePath部署边界未扩展。若以后需要新一轮实机验证，应另建隔离环境，不复活本次旧数据。
- 本轮任务的细节验证和清理已完成，旧上传/锁屏/还原待确认通知均不再催促；用户已回应此前结果，不能补发那些旧任务的完成提醒。
- 本次细节与清理任务已发送一次time-sensitive完成通知，notificationTriggered=true、1人time-sensitive、无fallback；该完成事件勿重复通知。


## 后续确认状态一致性修复（新QA已清理）

- 用户再次要求查找并执行优化。审查发现LibraryQuestionDialog和ArtifactPanel真实提交函数只检查忙碌锁，放弃确认期间仍能准备问题/保存版本。与已修上传表单一致，添加discard/confirmDiscard守卫，同时禁用底层输入、模型/格式和普通提交/取消；共享继续编辑/放弃区保留。未把所有表单统一改成新抽象，也未宣称全部穷尽。
- 新增discardSubmission.test.ts执行真实处理函数：发布基线2pass/2fail（确实准备问题、追加版本并清草稿）；候选4/0。候选688/0，合入原目录718/0（含原有WIP），两树类型/Biome通过；新UI/Tauri包与host Sidecar从隔离源码编译通过。
- 重新建立独立合成环境openhorn-confirm-6edllf78，backend58220、bundle com.openhorn.confirmqa；只有生成资料/成果及指向127.0.0.1:9的模型元信息，渠道占位值明确为q重复24次，无真实历史/凭据复制。
- 提问原生输入/取消后AX确报禁用，继续编辑后成功准备1个带来源的未发送草稿；弹窗截图滞留旧图层，缩放/诊断/关于窗口仍未可靠呈现，因此不能写成完整视觉通过，未用脚本改CSS伪造画面。成果原生截图清楚看到禁用正文/格式/保存/取消，Escape恢复保留草稿，再保存版本2成功。API/DB核对版本1原内容保留、问题1、会话1、消息0。未点击放弃或删除，未发送模型消息。
- 已提交普通推送92d86a5（产品和四项回归）、0217f50（报告/脱敏证据）。报告docs/2026-11-14_discard-submission-results.md与docs/audits/2026-11-14/discard-guards/validation.json保留全部边界。
- 新任务隔离根清理前3255424KiB，已停止QA后端、注销QA包、清理com.openhorn.confirmqa的WebKit/缓存/日志与偏好域、删除隔离工作树/原始数据/构建/私有环境和新tmp指针。候选3个脏路径先核对均已主线保存；273个原WIP路径除预期memory更新外保持原字节，原应用170/227和3002监听99476在清理时保留。新旧QA环境均不存在，不重开已删除包。
- 本轮已发送一次time-sensitive“确认状态保护已推送”，notificationTriggered=true，1人time-sensitive、无fallback；最终main与远端均为0217f50，勿重复发送本次完成提醒。
