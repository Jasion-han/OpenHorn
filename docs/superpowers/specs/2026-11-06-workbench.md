# OpenHorn 任务配方与产物工作台

用户已授权完成优先可靠性修复后，自主选择并实现适合的新玩法。本期选择任务配方与文本/交互页面产物管理；这是实施选择，不代表用户另行确认了每个字段。

## 使用流程

- 侧栏新增“工作台”，包含“任务配方 / 产物”两页，沿用现有布局、配色、字体与组件。
- 配方保存提示词、命名参数、所需Skills/MCP、项目/渠道/模型、输出格式和不可变版本。内置竞品周报、CSV分析、项目代码审查三个模板。已有导入提示词模板保持原格式。
- 点击运行前检查参数和已启用能力；缺项明确列出。创建绑定项目的Agent新会话，交接必须带目标conversationId；用户切换会话后不能误发。运行复用当前发送管线。配置检查不能声称连接已经验证。
- 配方可创建定时任务：冻结配方版本、参数与渲染prompt，关联projectId；后台再次检查要求，使用已修复租约管线。首期定时只支持Markdown输出，明确说明不支持的格式。
- 助手完成且已保存的回复可以收藏为产物；保存独立完整内容，不依赖源消息或临时URL。首期支持Markdown和其内部OpenUI/HTML围栏，以及显式文本HTML/OpenUI格式；二进制原件管理不在首版。
- 产物可以查看版本、查看原文、以原格式导出、返回来源、新会话继续修改；用户明确保存新回复为新版本。版本追加使用expectedVersion，冲突不能覆盖别人版本。源消息/会话删除不删除产物副本。

## 数据与接口

`RecipeSpec`: title/description/promptTemplate/parameters[{key,label,type:text|multiline|number,required,defaultValue?}]/requirements{skills,mcpServers,workspace,webSearch}/projectId?/channelId?/modelId?/outputFormat:markdown|html|openui。
`TaskRecipe`: id/version/spec/createdAt/updatedAt；`RecipeVersion`: recipeId/version/spec/createdAt。时间在HTTP DTO中为ISO字符串。

- GET/POST `/recipes`: `{recipes}` / `{spec}`→`{recipe}`。
- GET/PUT/DELETE `/recipes/:id`: 详情含versions；更新 `{spec,expectedVersion}`→`{recipe}`；删除无副作用执行。
- POST `/recipes/:id/prepare`: `{version,values}`→`{conversationId,prompt,requirements,recipeId,recipeVersion}`。
- POST `/recipes/:id/schedule`: `{version,values,frequency,time}`→`{task}`。

`SavedArtifact`: id/title/projectId:null|string/currentVersion/createdAt/updatedAt。
`ArtifactVersion`: artifactId/version/content/format:markdown|html|openui/sourceConversationId:null|string/sourceMessageId:null|string/createdAt。

- GET/POST `/artifacts`: `{artifacts}` / `{title?,sourceMessageId?,content?,format?,projectId?}`→`{artifact,version}`。
- GET `/artifacts/:id?version=n`: `{artifact,version,versions}`；versions是无content的元数据。
- POST `/artifacts/:id/versions`: `{expectedVersion,sourceMessageId?,content?,format?}`→`{artifact,version}`。
- PATCH `/artifacts/:id`: `{title,projectId?}`→`{artifact}`；DELETE删除自身及版本。

DB使用新task_recipes/task_recipe_versions/saved_artifacts/saved_artifact_versions表，不复用旧agent_artifacts。所有读取写入按userId验证，引用项目/渠道/消息/会话也校验所有权。schema/bootstrap同步；源消息删除SET NULL，副本独立。

## 视觉与交互契约

Extension模式：保留现有语义CSS tokens、系统字体、Lucide、Radix，4px节奏，8px面板圆角，细边框与低阴影。主标题24px，正文14–16px，次级文字12–14px。品牌一致性10/10、差异度2/10、密度6/10、动效2/10、交互确定性9/10。

工作台左侧为窄列表/筛选，右侧为详情与主操作；窄窗口堆叠，不强行横向挤压。错误就近显示，加载与提交态禁用重复点击，危险删除有明确确认。所有新增中文文案在agent.ts字典；空列表使用真实引导，不伪造个人数据。预览复用DesktopMarkdownMessage和现有GenUI沙箱，绝不把生成HTML放进可信原生WebView。无新配色/外部字体/CDN或框架。

## 验收

隔离DB覆盖跨用户访问、参数与模版注入边界、版本CAS、历史版本冻结、source删除、原文版本导出和备份往返。浏览器使用合成API与IPC覆盖真实表单/导航/运行目标绑定/收藏版本/错误恢复、窄窗与深浅主题。全套Server/Desktop测试、类型/格式、桌面构建通过。不得调用真实模型或写真实业务数据作为验收。
