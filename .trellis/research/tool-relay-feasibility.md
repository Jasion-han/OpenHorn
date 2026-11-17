# 工具 API 中转接入可行性（2026-11-15）

## 2026-11-16：通用Fetch与搜索来源标签完成原生验收

- 用户要求修复剩余已知问题。三个厂商原页面均命中系统Fake-IP，早先只兼容固定DeepSeek文档，不能作为通用解。新增`public-page-fetch.ts`：仅纯198.18/15触发固定HTTPS公共DNS的A/AAAA查询，全部结果必须公网且非本机；普通公网和独立DNS的连接均用curl --resolve固定已校验IP，保留Host/SNI/TLS。每次重定向重验、curl忽略curlrc/代理环境并剥离凭据，Stop/总超时结束子进程；未新增npm依赖或Key，无curl明确失败。固定DeepSeek官方docs保留此前TLS代理路径。
- 探测发现Bun裸undici导入忽略dispatcher；真实undici自定义TCP/TLS连接能收到头但正文在本环境挂起，已放弃、移除依赖；不能把HTTP200当作正文读取成功。改为系统curl后完整原文读取正常。
- Claude约1.34MiB HTML超旧直接读取上限，直接页面上限调整为2MiB且继续验证声明/流式长度；付费JSON仍1MiB，输出仍50,000字符。Google旧地址跳转后只给JS标题壳，增加同最终origin一次真实.md尝试，使用实际URL；仍是壳则明确失败，不冒充已读，不重置整体Stop/超时。
- Shared132、Desktop737、Sidecar378共1247/0，聚焦48/0，类型、host Sidecar及Tauri构建通过。真实直接读取Claude原页面、Google最终官方.md、OpenAI当前开发者.md成功。OpenAI旧`openai.com/api/pricing/`仍外部HTTP403，无绕过，不能声称旧地址已可读。
- **原生完成**：OpenHorn项目「验证联网与网页读取」（`1ef03a10-17c1-43f3-9c7d-99530d972315`）1次Search · Tavily（8.41秒）+3次Fetch（Claude3.11/Google3.68/OpenAI1.75秒），无MCP/本地工具/错误；工具过程4步30s。退出重启后重新打开保存对话，Tavily标记仍在，步骤展开留桌面。Google长页为有界原文片段，未伪装全文。用户Tavily选择/其他来源/MCP/Key/Jev均保持；证据`docs/audits/2026-11-16/public-page-fetch/validation.json`。未提交。

## 2026-11-16：Tavily切换生效但Search未标来源

- 用户切回Tavily后怀疑新会话仍用其他来源。核对「主流模型价格能力对比」（`9eae8ef4-13bd-4de9-9c5b-dbb163eb042f`）：4次web_search结果都有代码仅Tavily分支生成的`Untrusted provider summary (JSON)`段，无OpenRouter标记，MCP搜索0次；耗时10.52/2.01/7.71/2.19秒。当前Tavily已验证，配置无pending。旧事件没结构化来源，此判断来自结果结构与执行分支核对，非当时网络抓包。
- UI统一把内置工具显示Search，不能据此判断来源。新增共享`SearchExecutionSource`安全元数据，Direct/Claude由实际搜索分支生成，经WS/desktop projection/store到预览及展开步骤：Search · Tavily/OpenRouter；实际Tavily失败降级时显示DuckDuckGo并标Tavily降级。开始行和结果行按toolCallId更新，早开始事件合并保留，元数据随步骤持久化；不从当前设置或模型正文推断，不重写旧记录，MCP名与网页Fetch工具保留区分。
- 另3次内置Fetch（OpenAI/Claude/Google）因fake-IP校验失败，MCP网页读取恢复。此前固定DeepSeek docs例外未覆盖这些域名；当时来源显示修复未处理通用代理读取；后续已由上方固定公网IP传输修复，不是任意地址豁免。
- Shared132/0、Desktop737/0、Sidecar368/0，共1237通过，覆盖Direct/Claude×Tavily/OpenRouter真实受控工具回合、降级、流事件/合并/序列化/旧记录。类型/host Sidecar/Tauri最终包通过。保持用户Tavily选择，搜索/MCP配置与Jev环境摘要不变。
- **原生新标签已补齐**：锁屏解除后随上方通用Fetch完成联合验收，真实显示Search · Tavily且退出重启后持久化来源仍在；见`docs/audits/2026-11-16/public-page-fetch/native-validation.json`。原会话历史无来源元数据仍保持通用Search，不重写旧记录。未提交。

## 2026-11-16：官方文档Fetch的Fake-IP与Markdown修复

- 用户要求修复前轮两次`Fetch unsafe_url`。实际本机DNS将`api-docs.deepseek.com`解析为`198.18.0.25`，通用检查按保留地址拒绝；第二个根因是内置Fetch未接受`text/markdown`。产品`executeTool`读取原两个.md网址已成功，2.43秒和0.59秒，正文来自页面，不是搜索模型摘要。
- 修复新增页面专用`assertPublicPageUrl`：仅固定`https://api-docs.deepseek.com` origin、全部DNS为198.18/15且不命中本机接口时允许代理映射；其他网址/HTTP/端口/私网/混合DNS拒绝。付费工具仍用原strict guard；直接Fetch显式TLS验证、每跳重验、正文有界，新增Markdown MIME按原文处理。不是任意网站Fake-IP全局豁免。
- 曾探测公有DoH及IP固定连接方案：当前Bun内置undici导出忽略dispatcher lookup，Bun fetch的serverName实验未发出对应SNI，强制undici实现又遇TLS兼容错误，不能当成安全可用的通用固定IP传输；已放弃该方案，移除探测依赖，package.json和锁文件与入场前一致。只记录当前版本测得行为，不推广到其他版本。
- Shared131/0、Sidecar365/0，类型/Biome、host Sidecar及最终Tauri app构建通过；包内Sidecar与编译产物一致。独立Key、MCP/搜索配置和Jev环境未改。
- **原生Agent验收已完成**：原锁屏阻塞解除后核对最终app、包内Sidecar与源码哈希不变，检查完整草稿后发送问题。OpenHorn项目新对话「读取官方文档并核实」（`0c8a0101-15de-47af-a7a5-4b79eda58a53`）只有2次内置web_fetch且均返回原文，工具耗时1.42秒/0.32秒，工具过程2步11s，无unsafe_url、MCP/搜索/本地工具调用，回复completed；展开并保留桌面及对话。持久化工具事件是截取的结果摘录，不作为完整页面长度。正式证据`docs/audits/2026-11-16/fetch-proxy-markdown/native-validation.json`及原生截图；临时目录/指针已清理，未提交。

## 2026-11-16：Agent被MCP搜索入口绕过

- 用户截图及原生展开确认：GPT Direct Agent 在当前OpenRouter来源下调用了`tavily-hikari/tavily_search`，随后`tavily_extract`；不是OpenRouter失败降级。前次Chat演示没有覆盖Agent，不能据此宣称Agent已经遵循所选来源。
- 根因是Direct注册时把所有MCP工具与内置`web_search`直接合并。新增按回合应用的MCP搜索策略：普通回合过滤已识别的通用MCP网页搜索；保留原服务配置、其他工具和按URL阅读工具。判断基于工具名称/明确网页搜索描述，不能保证识别不透明自定义工具；外部CLI/ACP工具目录未改。
- 显式`/server`的`targetMcpServer`从桌面经WS schema传至Direct，只放行该服务且仍需联网许可；仅一个服务或名字未命中不等于显式指定。共享提示明确普通搜索使用产品当前来源。
- Sidecar363/0、Desktop734/0，最终聚焦24/0；类型/Biome、host Sidecar和最终Tauri构建通过。受控Direct运行时回归提供竞争Tavily搜索和URL阅读工具，检查前者不进入工具表、后者保留；工具回合仅调用受控OpenRouter Flash接口，MCP搜索调用0次。当前仍是OpenRouter Flash，Tavily/Jev/MCP配置逐值或摘要核对未改。
- **原生Agent实测已完成。** 原锁屏阻塞解除后，确认最终包SHA与源文件未变，在OpenHorn项目新建「核实联网搜索支持模型」（`827102b3-8a37-4be4-91e7-655eac594cc9`），发送相同问题、不点名工具。真实Search返回明确OpenRouter web search (Exa)，当前模型Flash，tavily_search为0次，回复completed；步骤展开并保留。Search工具起止10.46秒，界面工具过程4步27s，不能用前次4.76秒样本代替本轮耗时。两次内置Fetch返回unsafe_url后由Exa按URL读原文恢复；该历史读取问题已由上方官方文档Fetch修复及原生验收解决，未全局放宽URL校验。证据`docs/audits/2026-11-16/agent-search-source/native-agent-validation.json`及`validation.json`。

## 2026-11-16：OpenRouter切换轻量Flash

- 用户嫌Pro验证18.65秒太慢，要求更轻量、更快。公开模型目录确认`deepseek/deepseek-v4-flash`支持tools/reasoning；官方文档支持`reasoning.enabled=false`和`provider.sort=latency`。实现Flash默认、最多三条简短结论、关闭推理、低延迟优先，保留Exa与结构化引用校验、禁付费重试。
- 旧显式Pro保留，新增Flash候选不能复用Pro验证指纹；失败时继续旧模型。桌面显示候选实际模型，改Key不暗改模型，Sidecar严格允许Flash与旧Pro。
- 使用原独立Key，首次产品验证成功启用Flash，但结果收集脚本误用了未指定keys的GET/settings，计时未能落盘；修正后显式只验证一次，4.76秒成功。共两次明确验证，无自动重试；不能用该单次样本保证稳定提速。Tavily/OpenRouter均保留且已验证，Jev环境文件未变。Server646、Desktop734、Sidecar357、Shared128全绿，浏览器23组、类型/Biome/host Sidecar及桌面构建通过；已重启最终原生包并实际观察Flash、两来源菜单及Tavily原Key，恢复OpenRouter视图。本轮临时目录/指针及关闭测试库已清理，未提交。最终证据`docs/audits/2026-11-16/openrouter-flash/validation.json`。

## 2026-11-16：修正误隐藏原有Tavily

- 上轮将“可用且不重复”过度解释成“只展示新验证记录中的来源”，误隐藏了原来使用的Tavily；配置和Key未删除。用户明确Tavily也要保留，因此不再将缺新验证记录当作不可用或隐藏依据。
- 新增`configuredProviders`与已验证目录分离，主列表保留两者并去重；未验证旧连接显示“待验证”，未配置类型仍需主动配置。Tavily与OpenRouter是两个独立来源，不能合并。DeepSeek协议去重优先当前/已验证协议。
- 通过独立验证路由只检查不切源，真实Tavily查询仅一次，7.28秒成功；保护字段逐值对比确认原Tavily Key/开关、当前OpenRouter来源/凭据/验证记录未变，Jev环境文件未改。两者现均已验证，默认仍是OpenRouter。
- Server645/0、Desktop734/0、浏览器22组、完整类型/Biome及Tauri构建通过；实际重启原生应用，展开看到两个选项，进入Tavily见原Key掩码后恢复OpenRouter，未重复验证。证据`docs/audits/2026-11-16/tavily-restore/validation.json`。任务临时数据已清理，未提交推送。

## 2026-11-16：OpenRouter同级来源实施

以下“仅OpenRouter”是当时验收状态，已由上方Tavily误隐藏修复取代，不能重新按缺验证记录隐藏已有连接。

- 用户要求直接接入，随后明确“不要搞这么多，只保留可用且不重复”。新增`openrouter`独立来源，固定已实测的DeepSeek Pro+Exa，独立搜索Key，与Jev分开。默认列表只展示验证指纹匹配的活动连接，并将DeepSeek两种协议去重；其他类型仅在显式配置入口中出现。当前主列表只有OpenRouter。`:online`不是专用DeepSeek搜索模型且已弃用，当前目录与端点未发现原生转发能力，因此不伪装为DeepSeek官方原生搜索。
- 候选/active加密、指纹与revision事务、专用两段保存API和后端能力标记已接通；Chat/SSE及桌面所有入口到direct/Claude Search贯通，严格来源解析和取消，无付费自动重试/降级。Agent可读取原文，服务端Chat保留已有链接读取门控。
- 最终自动化1953/0（server643、desktop733、sidecar357、shared126、adapters94），设置浏览器22组，类型/Biome、host Sidecar/精简后Tauri包通过。覆盖GPT/Claude准备/完成、OpenRouter完整Chat取消入口、可用目录、去重和默认已启用按钮禁重复验证；三次限定复核无P1/P2。真实WS handler到Search尚无单一端到端测试，不能把分段测试当成该项。
- 真实产品验证API仅调用一次，17.05秒成功并启用；候选/active均加密，runtime与独立Key一致，Jev环境文件未改。精简展示后没有再次收费验证，检索适配/验证指纹未变。最终后端PID80188健康，`effectiveProvider=openrouter`、`verification=verified`、`availableProviders=[openrouter]`。解锁后已退出旧进程并打开精简后的最终原生包，实看主列表只有一项，确认验证通过、禁重复验证和草稿取消恢复；原生默认/选中/键盘态有截图，独立hover由浏览器夹具覆盖。
- 计划`docs/superpowers/plans/2026-11-16-openrouter-search.md`，证据`docs/audits/2026-11-16/openrouter-search/validation.json`与原生截图`native/06`至`09`。正式证据保留，任务临时材料和关闭测试库已清理；保留运行应用/后端、用户配置及无关WIP。未提交；后续ship需包含前轮关联依赖并排除无关WIP。

## 2026-11-16：独立 OpenRouter Key 的 DeepSeek 联网实测

- 用户提供独立 OpenRouter Key，明确不得复用 Jev 的 Key。本次仅在临时测试进程内向 `https://openrouter.ai/api/v1` 使用该凭据，未读取或修改 Jev 配置，未持久化新 Key、未改变项目当前搜索源。
- 认证接口返回200；公开模型目录存在`deepseek/deepseek-v4-pro`。该模型当时15个端点的`native_tools`均为空，绝大部分`supports_tool_choice.required=false`，仅一个为true。不能把模型存在或`tools`参数支持当作DeepSeek官方原生联网转发证明。
- Context7一手依据：OpenRouter `guides/features/server-tools/web-search.mdx`、`guides/features/server-tools.mdx`和`openapi/openapi.yaml`。`auto/native`引擎都可能降级非原生引擎；本次明确指定`engine=exa`，测试的是OpenRouter搜索+DeepSeek处理，不宣称DeepSeek原生搜索。
- 共主动发出两次POST，无脚本自动重试：首次强制`tool_choice={type:"openrouter:web_search"}`且`reasoning.enabled=false`返回400；第二次改`tool_choice="auto"`、去掉reasoning覆盖并禁provider fallback，`max_uses=1/max_results=3/max_tokens=2000`，返回200、`finish_reason=stop`与3条结构化`url_citation`（DeepSeek官方Responses指南、Web Tools指南、Responses参考）。因同时修改两个参数，尚不能把首个400唯一归因于强制工具选择。
- 成功请求实际模型为`deepseek/deepseek-v4-pro`、provider为Relace，4968 tokens，API报告该成功请求`usage.cost=0.0113182 USD`；不把该数声称为所有失败/成功尝试的账单总额。
- 当前桌面`deepseek-native`仍只接官方契约，不接受OpenRouter Key；`DeepSeek搜索接口`也不能只改为OpenRouter地址，双方工具协议不同。本次完成的是API层可行性实测，未新增桌面OpenRouter来源、未声明产品已接通。已有共享`routerWeb`仍使用强制工具选择，也未通过本轮完全相同参数的真实验证；后续接入需使用经验证的OpenRouter协议、独立凭据和严格来源判断。

## 当前方案：独立原生联网与其他搜索来源同级

- 用户再次指出高级原生开关与上方来源冲突，明确确认：GPT/Claude回答时也能单独选择DeepSeek原生联网检索。因此移除高级覆盖开关，新增同级`deepseek-native`，旧独立DeepSeek工具接口明确命名并保留。
- 官方Responses文档 https://api-docs.deepseek.com/guides/responses_api/ 与 https://api-docs.deepseek.com/api/create-response/ 明确：原生web_search支持deepseek-v4-pro，Flash会忽略。新连接不复制旧Chat/Flash判断。官方固定端点用HTTPS/TLS且禁重定向；对完整固定端点的DNS分类豁免支持Clash fake-IP，任意中转仍严格检查。
- 新原生检索用单独官方Key或合格渠道引用，显示模型、接口和凭据来源；配置冻结模型/地址，候选/active加密并区分，成功检索验证才激活。数据返回标记为模型生成摘要与结构化来源，不能作为页面原文；其他回答模型不拿到原生检索Key/推理/私有状态，回答模型的空引用/原生计数也不能覆盖已检索来源。
- 旧后端兼容需失败关闭：专用两段Native Key PUT与能力标记避免未知secret被旧通用设置明文保存。旧nativeWebEnabled不再决定Chat来源。
- 已补权限/取消：关闭联网不启动检索或天气；分类与SSE编辑/重试贯穿signal。前置检索有用户/会话/nonce取消通道，停止后返回已持久化的stopped回合而非留临时ID；新请求不能被晚旧准备覆盖。
- 上传前即登记Stop与全局回合所有权；`stoppedBeforeStart`确保取消请求失败或上传超过墓碑有效期时也不启动检索。已停止上传失败仅保存经过校验的附件元数据并提示上传未确认；取消失败即使晚于准备响应也必须显示，不能吞掉。
- 当前自动化：1906项Bun/0失败，搜索配置浏览器14组、真实Chat组件62组、类型/Biome/host Sidecar/最终桌面包构建通过。2026-11-16解锁后已通过CUA退出旧进程并启动最终构建，实机查看四来源、原生Key/模型/接口说明、输入并取消合成草稿，查看中转地址及DuckDuckGo，最后恢复Tavily；原生默认/选中/键盘态有截图，独立hover由浏览器夹具验证，原生拖动尝试未留住hover帧不计通过。源码及二进制哈希仍与自动化版本一致。后端健康，实际仍为auto→Tavily、旧开关仍true且未改动，合格官方Pro复用渠道为0。未用真实Key收费验证、未保存真实Native配置。证据与清理结果为`docs/audits/2026-11-15/independent-native-search/validation.json`，计划为`docs/superpowers/plans/2026-11-15-independent-native-search.md`。仍未提交，后续ship须带上前几轮未提交依赖并排除无关WIP。

## 历史：单一有效搜索源与显式能力验证（高级覆盖开关已由上方方案取代）

- 用户指出任意GPT/OpenRouter等聊天渠道出现在DeepSeek下拉列表会误导“可选即支持”，并确认执行优化。上一轮“保存即激活”和“默认任意模型渠道选择器”的方案被本节取代。
- 已核对官方一手文档：https://api-docs.deepseek.com/api/search/ 与 https://api-docs.deepseek.com/guides/search/。独立Search API确实为POST /v1/tools/search；中转是否真实转发仍须显式验证，模型可调用不构成证明。通过Context7核对，未用真实Key。
- 当前统一来源面板：Tavily、DeepSeek、DuckDuckGo互斥，顶部显示实际当前来源。DeepSeek只填Key，地址折叠；旧渠道引用只作已有配置读取，不再展示任意聊天渠道列表。保存候选不改活动凭据；点击“验证并启用”才发一次可计费搜索，结果协议/网页来源验证成功后原子切换。
- 复核发现并补齐：已验证渠道变化必须撤销运行时而非只改标签；旧无效DeepSeek来源保存候选必须保留active空哨兵；表单与revision同事务返回，避免多窗口把X配置展示和Y版本拼接；generic provider/auto/旧Tavily开关的PUT/DELETE都受验证门控。原始旧有效配置保持读取兼容、状态标明未验证。
- 并发回归先复现旧实现失败（表单X提交Y版本；两个旧开关请求组合启用未验证Tavily），修复为表单baseline绑定activationRevision、同事务检查/写与短事务串行化。另拒绝将未激活DeepSeek候选用于默认来源的链接读取，旧工具凭据写入及专用候选配置删除也保护active连接，防止删除后回退复活其他凭据（已先复现失败后修复）。
- 最终工作区测试1871/0、12组浏览器检查、完整类型/Biome及Tauri debug构建通过；最终构建已在解锁后重新打开，实机观察三种来源、未启用不切换、草稿取消并恢复Tavily。未调用真实Key或保存真实搜索配置。
- 界面和运行时的权威契约见`.trellis/spec/server/backend/provider-tools.md`与`.trellis/spec/desktop/frontend/component-guidelines.md`；验证证据为`docs/audits/2026-11-15/search-source-clarity/validation.json`。全部相关改动仍未提交，提交时继续遵守下方前置依赖警告。

## 历史：固定DeepSeek搜索块并收简字段（已由上方取代部分交互）

- 用户指出此前通用工具表单过于复杂，并明确要的是DeepSeek本身的搜索能力，官方或中转只改变接入通道。已确认不再让用户选择搜索来源、连接方式和模型；默认渠道选择器，手填仅Key，地址按需展开。此要求取代下文历史通用工具方案。
- 已实现搜索专用加密`deepseek.searchConnection`与只读`deepseek.searchRuntime`；保存连接和激活DeepSeek搜索在同一事务。使用SQLite中途失败触发器验证过全部回滚。新配置无效不借旧凭据，旧OpenRouter自有搜索配置不当作DeepSeek搜索；不做真实付费自动探测，也不宣称任意聊天中转支持搜索接口。
- 主界面现为DeepSeek搜索，默认只有接入渠道和保存。下拉末项为单独填写API Key，官方地址默认收起。原生联网开关移到独立折叠高级设置，OCR不再混在搜索表单里；保留其单独确认路径。
- 真实桌面发现取消手填后Radix Select显示残留：根value由字符串变为undefined。新增浏览器回归确实复现（期望“选择已有渠道”，实际“单独填写 API Key”），改为始终受控后通过，并在最终原生包再次点击手填/取消，实际截图看到正确占位与无Key字段的默认布局。
- 当前工作区完整Bun回归：desktop721、server598、sidecar346、shared/adapters178，合计1843/0；10组浏览器验证、全项目类型、全仓Biome（887文件）、host Sidecar和Tauri debug app构建通过。实际新版已打开到默认DeepSeek搜索卡片，未保存真实用户配置、未发起付费搜索。
- 证据为`docs/audits/2026-11-15/deepseek-search/validation.json`。全部本轮实现仍未提交，原有WIP继续保留；旧通用工具报告仅作历史，不能再次把OpenRouter工具协议自动等同DeepSeek搜索。
- Git HEAD仍为此前配色提交dc820f0。本轮依赖前轮尚未提交的shared工具连接契约、服务端配置解析、运行时字段传播等；后续ship不能只提交本轮新增文件而漏掉前置依赖，应验证完整相关候选树。原有无关可靠性/迁移WIP不整批提交，GeneralSettings头像补漏仍只取对应单行hunk。

## 已确认的现状

- 以下为前一轮历史：当时统一为单一地址/Key/可选模型表单，但仍误做成通用工具服务；现已按上方最新要求纠正，不再作为当前界面方案。
- 独立 Search/Fetch 在 `packages/shared/src/search/deepseekProvider.ts`，OCR 在 `apps/server/src/services/libraryOcr.ts`，当前固定 DeepSeek 官方端点。原生联网由 `packages/adapters/src/deepseek-native-web.ts` 限制官方 origin/model，使用聊天渠道密钥。
- Search/Fetch 同时服务 server 和 Sidecar；配置传播经过 `sidecarRunSupport`、ChatArea 的发送/重试/编辑、后台任务、Sidecar WebSocket schema 与 direct runtime。只改 server 或设置表单不能交付完整支持。
- 账户头像和 DeepSeek 控件局部黄色补漏仍未提交；GeneralSettings 同时混有原有编辑器检测 WIP，后续提交必须仅取头像单行 hunk。

## 官方文档核对

通过 Context7 `/openrouterteam/docs` 核对以下官方源文档，未发送真实付费请求，未使用用户密钥：

- [OpenRouter Web Search](https://github.com/openrouterteam/docs/blob/main/guides/features/server-tools/web-search.mdx)：支持 `openrouter:web_search` 服务端工具；旧 `plugins: [{id: "web"}]` 与 `:online` 标为 deprecated。检索可能由模型决定，不能把普通模型回答当成已执行搜索；来源可通过标准 URL citation annotations 提取。
- [OpenRouter Web Fetch](https://github.com/openrouterteam/docs/blob/main/guides/features/server-tools/web-fetch.mdx)：`openrouter:web_fetch` 经 Responses API 读取指定网页/PDF，结果供模型使用；与 DeepSeek 独立 `/v1/tools/fetch` 响应协议不同。
- [OpenRouter PDF Inputs](https://github.com/openrouterteam/docs/blob/main/guides/overview/multimodal/pdfs.mdx)：支持 Chat Completions/Responses 的 PDF 输入与 file-parser 引擎。文档解析、模型生成内容和当前逐页 DeepSeek OCR 结果是不同契约，不能直接伪造页码、完整性或逐字识别保证。
- [OpenRouter OpenAPI](https://github.com/openrouterteam/docs/blob/main/openapi/openapi.yaml)：工具选择有 required 与直接服务端工具类型写法；具体模型/上游的支持仍须实际核对。

## 调研时提出的接法（历史方案，实施结果见下）

1. DeepSeek 工具兼容中转：允许自定义 Base URL 与该地址对应的 Key，前提是服务商真实转发三个工具端点并保留协议。需要地址规范化、请求目标校验、禁止携带凭据重定向，以及地址/密钥绑定保存，避免部分保存把旧密钥发往新地址。
2. OpenRouter：实现单独适配器，使用其服务端搜索/网页工具与文档解析协议，复用已有渠道或独立工具配置；明确模型选择、计费及能力差异。不能将其 Key 直接发至 DeepSeek 官方，也不能假定修改 Base URL 就完成适配。
3. 仅有 OpenAI 兼容聊天接口的普通中转：可配合现有 Tavily/DuckDuckGo 为聊天提供联网；文档识别需要额外视觉/解析能力与专门适配，不能承诺任意中转具备 DeepSeek 工具服务。

不要求用户在对话发送Key。尚未指定的真实中转站，不按“聊天兼容”推断其工具能力。

## 实施与验证结果

- 已完成shared连接契约与Search/Fetch适配、server加密单行保存与渠道归属解析、旧Key兼容，以及Sidecar发送/编辑/重试/后台任务的字段传播。原生DeepSeek Chat的官方origin/model门控保持独立。
- OpenRouter搜索读取来源citation，网页读取仅接受目标URL对应的来源原文；不接受模型声称已搜索或生成的网页摘要。PDF索引仅取file-parser annotation原文，拒绝截断、拒绝、缺失文字或含未解析图片块的响应；图片/Office在此OpenRouter入口明确不支持。
- 上传确认通过只读tool-status显示实际目标地址并取得连接指纹；确认后地址/Key变化则在发请求前报冲突。真实账户未保存任何新配置、未上传资料、未使用真实Key付费验证。
- 最终当前工作区测试：desktop721、server596、sidecar346、shared/adapters176，合计1839通过、0失败。全项目typecheck、全仓Biome（881文件）、host Sidecar编译和Tauri debug app构建通过。server完整回归中曾有一次旧导入锁竞争fixture的SQLITE_BUSY；单独10项及随后完整596项均通过，未修改或削弱该测试。
- 浏览器9组验证包括：失败加载/重试、只有一个表单且无供应商selector、展开选项/hover/selected/键盘浅色态、保存失败草稿与重试、地址变化清Key、渠道引用不复制Key、OCR逐弹窗确认等。
- 实际退出旧应用，重启3002服务与新桌面包。先前版本实机验证中转输入及改地址清空生成Key；按新反馈统一入口后，再实机看到手填地址/Key/可选模型表单，以及复用Openrouter渠道时带出实际地址和默认模型。最终恢复原始手填官方地址、空Key/模型、auto搜索、原生联网off，保存/取消均禁用；未点击保存。部分原生捕获曾noWindowsAvailable/菜单画面滞后，经原生Window→Zoom再恢复尺寸后，表单截图可见；不将所有菜单帧记为完整原生视觉通过。
- 修改前记录274个既有脏路径哈希；最终267个无关路径逐字节保留，5个相关源码WIP仅叠加本次功能，2个记忆日志/索引按预期更新。成果尚未提交，既有大量WIP继续保留。脱敏摘要见`docs/audits/2026-11-15/tool-service/validation.json`。

## 2026-11-17：PDF 图文输入与深度研究补充

- 采用本地 PDF.js 选页渲染，不把 OpenRouter Key 当作 DeepSeek Files API Key。页面图片通过现有 vision attachment 通道发送，Agent 只在账户隔离 IndexedDB 缓存可恢复时重试；停止或缓存缺失时要求重新附加。
- 深度研究使用现有 Search/Fetch 和 OpenAI、Anthropic、Google API adapters，禁止 MCP、Shell、Skills、CLI/ACP 和 SDK resume。外层预算为唯一搜索4、页面6、工具轮12、总时限180秒；失败请求占预算，供应商内部操作不冒充计费上限，报告引用必须来自结构化证据。
- 实际复现 Bun/Hono multipart 在二进制 NUL 处截断并丢失重复 `files` 字段；上传改用有界 busboy，并由客户端核对回执的数量、文件名、大小和 ID。该结论已通过 loopback HTTP、Hono、临时 SQLite 和四文件字节回归。
- 证据：`docs/audits/2026-11-17/document-research/validation.json`；下午补充真实桌面请求见同目录 `native/live-session.md` 与 `native/live-session.json`。真实 Files/OCR 与研究质量统计仍未测。
- 用户随后明确要求提交所有代码，已将此前产品 WIP、可靠性与迁移分批提交推送。真实桌面研究首轮失败暴露重复综合与草稿误展示；50912fc 改为证据/引用均校验的完整报告直接结束，未校验草稿不当正文，综合阶段仍受 180 秒总期限约束。复测会话“搜索接口对比复测”37 秒成功，两次 Tavily 搜索、一次 Fetch，SQLite completed，最终步骤为 text，重启恢复。
- 真实 PDF 选第 2 页（无可提取文字），关闭联网，模型识别左橙红/右绿、右柱约 1.8 倍；PDF 原件和页图已保存，原件字节一致。两个成功会话保留供用户检查，样本不能推断供应商速度/长期质量保证。
- 2d14ab5 移除会误匹配闭合星号的原始字符串 CJK 加粗预处理，改为只处理 Markdown 普通文本节点；代码、转义字面量、链接地址不参与修复。实机重启后两个真实回答的加粗正常，最终适用测试 2062/0。


## 2026-11-17：后续边界复核与锁屏交接

- 已复现并修复：研究重试仅有工具进度时失败/Stop/空结束覆盖原报告；按钮显现首击竞争；回车绕过旧运行时/联网前置检查；缓存六张上限图片的 Base64 超过8MiB、过期未完整清理及存储错误不统一；上传 MIME/畸形 JSON 回执未进入草稿恢复路径。缓存单条12MiB、账户50MiB、7天；cursor计量和回收过期，不驱逐未过期内容。
- 原生“核实官方搜索接口”问题触发引用拒绝后，离线反例确认代码内 API URL 被当作来源、代码内唯一来源也能误通过；553bb9f 用 micromark 区分代码与正文，正文仍必须引用实际证据。原生同一问题26秒完成，两次Tavily搜索、一次Fetch；此样本不证明稳定提速，未保留被拒报告全文，不断言所有历史失败都是此原因。
- 原生再次复现关闭本会话联网后重试仍搜索，定位为 memo 化消息旧回调捕获过期策略；1b043e9 改为重试/编辑点击时读取当前会话联网与全局Full Access，并保留准备期研究标记。回归夹具使用真实会话更新链路；两种开关方向和权限参数均通过。长期边界同步到 `.trellis/spec/desktop/frontend/state-management.md`。
- 当前自动化：Shared134、Adapters100、Desktop777、Sidecar410，1421/0；Chat真实组件69组、PDF/真实IndexedDB7组通过，类型/Biome/Sidecar与Tauri构建通过；Server源码未改、未重复全量测试。代码已分批推送main，证据 `docs/audits/2026-11-17/retry-cache/README.md` 与 `validation.json`。
- **未完成原生验收**：最终实时策略修复包重启后，桌面工具持续cgWindowNotFound，系统只读确认 `CGSSessionScreenIsLocked=true`，应用/Sidecar存活且无对应崩溃；已发送一次需要解锁通知。尚需解锁后验证“联网关闭重试拒绝且保留报告”和“已有检索步骤后Stop保留报告”。当前该验收会话联网为false，先验此状态，随后恢复true验Stop。数据库只读对比确认保存报告仍为completed且与锁屏前基线完全一致；不能把浏览器回归或进程存活记成这两项原生通过。临时原始比较快照清理，正式证据和验收会话保留。

### 解锁后的最终原生验收

- 用户确认解锁后，实际打开最终 OpenHorn 桌面包，在“核实官方搜索接口”会话关闭联网状态点击重新生成：立即提示深度研究需要开启 Web Search、原成功报告已保留。正文、3步/31s与16:53时间戳仍在；只读SQLite逐字段确认 `id/content/agent_run/updated_at/finish_reason` 完全不变，assistant仍只有一行。
- 恢复该会话联网开启后再次点击重新生成，实际看到“处理中 · 10s · 1 个步骤”及 Tavily 官方文档 Search 查询，再点击Stop。原成功报告恢复，同一完整assistant行再次与基线完全一致。切换到PDF会话再回来，原报告和来源仍在，Web Search为true。31s属于原报告，不能记为被停止重试的执行耗时。
- 上述两项取代前段“未完成原生验收”的当前状态，锁屏记录保留为历史。未发现新产品问题，未修改产品代码；更新验收材料并保留真实会话，清理本次临时比较快照。证据仍为 `docs/audits/2026-11-17/retry-cache/README.md` 与 `validation.json`。
