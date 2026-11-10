# Project library implementation plan

**Goal:** 可保存原件、明确索引状态、按项目关键词检索与准备有来源Chat问答，并支持备份恢复。
**Architecture:** SQLite有界原件/元数据和关键词片段表；复用pdf-parse、chunkText和普通Chat交接。上传/索引/检索不调用模型。原有附件向量RAG保持原行为。
**Tech stack:** Hono/Bun、Drizzle/LibSQL、React/Zustand、Bun tests、Playwright。
**Spec:** `docs/superpowers/specs/2026-11-10-project-library-design.md`

## Contracts and review focus

- shared/library：5MiB文件、50MiB原件总量、100资料、2MiB单正文、25MiB正文总量、1000片段、200问答记录；文件名200字符、问题500字符、引用完整JSON24KB；问题记录可显式删除以回收额度，关联聊天保留。
- 文本拒绝非法UTF8及非换行/制表之外C0控制字符；PDF最多100页，解析并发有界，扫描件/解析失败保留原件并显示失败。
- scope为personal或用户拥有的项目；all仅管理/搜索，准备问答须具体范围。项目删除资料级联，提示包括资料；问答快照独立保留为不可用原项目范围。
- 用户/项目隔离、claim/删除竞态、重复上传与请求ID指纹、备份范围降级/解压预算、迟到窗口与原生保存回执为重点验证。

## 1. Shared contracts and schema

- [x] 创建 `packages/shared/src/types/library.ts` metadata/detail/search/prepare/question DTO；`shared/library.ts`限额、文件类型、关键词、来源装箱/提示词及data-only判定。导出subpath/types。
- [x] `packages/db/src/schema/index.ts`与`apps/server/src/db/bootstrap.ts`增加library_documents/library_chunks/library_questions；文档存originalBase64、SHA、状态、revision/token/lease，列表不读原件。唯一键(user,scope,fileName,sha)、问题(user,requestId)。
- [x] 纯helper单测验证UTF8字节装箱、词条及data-only。

## 2. Library backend

- [x] `services/libraryService.ts`：list/get/importOriginal/indexDocument/deleteDocument/search/prepareQuestion/listQuestions/getQuestion/deleteQuestion；typed错误、用户/范围检查、事务配额、claim CAS、幂等准备与冻结来源。
- [x] `services/libraryParser.ts`：buffer解析，文本fatalUTF8，PDF最多100页/有界并发；失败不假装ready。过期indexing显示可重建。
- [x] `routes/library.ts`：metadata/detail、multipart upload、原件attachment下载、index/delete、search、question prepare/history/delete；body限额，不暴露原件Base64于普通JSON响应。
- [x] 隔离测试覆盖边界、失败、跨用户/项目、并发/租约和来源快照，HTTP测试使用独占DB。

## 3. Chat isolation and navigation

- [x] `messageService.ts`及`appendSystemPrompt.ts`统一data-only helper；library标记跳过全局摘要/附件RAG/实时路由和GenUI追加。
- [x] 复用`pendingPrompt(autoSend:false,conversationId)`和现有渠道模型；准备只落真实草稿/问答记录，不运行模型。已删除会话请求ID不可重放。
- [x] enable `library` activeView与原侧栏入口；仅库页面的范围决定新检索，不暗改全局聊天记忆。

## 4. Backup and search integration

- [x] export同一快照收集资料/问题，新增entries/manifest与容量估算，不导出临时索引租约；原件在DB，无新磁盘路径权限。
- [x] import严格编码/大小/hash验证和用户范围ID/项目/会话/渠道重绑，重建本地索引；旧备份兼容/重复导入幂等/缺项目不变个人资料；ZIP真实解压字节及重复entry限制。
- [x] import part/结果文案识别资料库；统一搜索新增资料名/正文结果并定位库详情，不调用模型。

## 5. Desktop

- [x] `library/LibraryView.tsx`及upload/question/history局部组件、`lib/libraryApi.ts`和i18n：项目选择/列表/状态/原文与命中片段，More下载/重建/删除/问答；设置默认折叠、单层放弃确认。
- [x] 读写按owner/范围/对象/导航epoch守卫；文件上传/原生下载/准备会话失败保留草稿、无重复请求或迟到原生窗口。删除资料/问题记录明确确认范围。
- [x] 浏览器完整流程、范围切换/失败/重建/重复提交/问答交接/来源/删除/备份，假提供方验证不污染真实数据。

## 6. Delivery

- [x] 相关单测/全量类型格式、既有搜索工作台回归、原生构建；真实数据仅查看空库，不上传真实资料/发模型。
- [x] 独立审阅、报告与证据/契约/会话记录，已知服务端并发超时如实记录；不自动提交推送。

## 验证记录补充

完整结果见 `docs/2026-11-10_project-library-results.md`。纯helper与HTTP/事务/备份边界在独占SQLite子进程82项检查中验证；资料库浏览器15组走真实Hono/SQLite，备份往返在服务测试验证，未在真实用户库导入测试文件。最终服务全量采用单项并发1、20秒时限，525通过；默认5秒首次超时与连锁失败如实保留于报告。未进行Git提交。
