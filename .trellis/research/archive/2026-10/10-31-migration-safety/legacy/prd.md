# 数据库迁移安全：自动备份与旧库可启动

## 背景（第一性原理）
1. 2026-10-31 一个有缺陷的回填在开发服务器（`bun --watch`）自动重启时直接作用于真实库，截断了 6 条回复，
   靠 7 月的手动备份才救回。当时的「修复」是人为约定（改迁移前先停服务器），不是机制。根因：服务端启动时
   执行会改写数据的迁移，**执行前没有任何自动备份**；出错只能指望碰巧存在的手动备份。
2. 复核发现 `data/openhorn.db.bak-20260728-175016`（7 月的真实旧库）**无法启动**：bootstrap 的
   `ensurePasswordHashNullable`（`apps/server/src/db/bootstrap.ts` ~1124）报
   "users has 9 columns but 7 values"。即：从旧版本升级的用户启动即失败。根因需定位（重建表时列清单与
   实际列不一致？）。
3. `ONE_TIME_MIGRATIONS` 用 `PRAGMA user_version` 计数（~1544-1575）。风险：外部工具设置过 user_version 的
   库会静默跳过迁移。

## 目标
1. **迁移前自动备份**：bootstrap 在执行任何会改写既有数据的步骤之前（至少：有待执行的 ONE_TIME_MIGRATIONS，
   以及其它会重建表 / 改数据的 ensure* 步骤——逐个梳理哪些是破坏性的），用 SQLite 一致性快照
   （`VACUUM INTO` 或 libsql 等价方式）把库备份到 `data/backups/`（路径相对 DATABASE_URL 所在目录），文件名含
   时间戳与迁移前 user_version；只保留最近 N 份（如 5）。无待执行迁移时不备份（避免每次启动都拷贝）。
   备份失败则**不执行迁移**并明确报错（宁可启动失败也不在无备份时改数据）。内存库 / 测试库跳过。
   注意 `.gitignore` 是否已覆盖 data/。
2. **旧库可启动**：定位 `ensurePasswordHashNullable` 在 7 月旧库上的失败原因并从根上修（让表重建按实际列
   动态生成 / 只在需要时执行），然后用该旧库的**副本**完整跑 bootstrap 验证：能启动、消息正文无丢失
   （逐行对比 content；agent 回复按 38d0a25 的规则正文可变为步骤推导但文字不丢）。再检查其它 ensure* 步骤对
   旧 schema 的健壮性（同类「按固定列清单重建表」的写法）。
3. **user_version 健壮性**：评估是否改为显式迁移记录表（如 `schema_migrations(id TEXT PRIMARY KEY, applied_at)`，
   按迁移名记录）以避免外部 user_version 干扰；若改，需把现有 user_version=2 平滑映射过来。给出决定并实现。
4. 测试：备份在有待执行迁移时创建、无迁移时不创建、失败时阻止迁移、保留数量；旧 schema 下
   ensurePasswordHashNullable 不报错；迁移记录机制。

## 约束
**开发服务器已停止，实现期间不要启动它；不要写 data/openhorn.db**（只读 sqlite3 与副本可以）。
DB schema 若新增表需两处同步（packages/db schema 与 bootstrap.ts）。服务端 mock.module 规则；Biome。
跑 server / desktop / shared 测试与 server tsc。不提交。

## 验收
有待执行迁移时启动会先在 data/backups 留快照；7 月旧库副本可完整启动且正文无丢失；迁移记录不受外部 user_version 影响。

## 实现记录（与 PRD 不同之处 / 证据）
- **旧库失败根因**：`ensurePasswordHashNullable` 用 `INSERT INTO users SELECT * FROM users__ph_mig` 按位置拷贝。7 月库 users 只有
  7 列且 `token_version` 在最后，而重建后的表有 9 列（含 email_verified / image，顺序也不同），所以报
  "9 columns but 7 values"；就算列数碰巧一致，值也会错位写进别的列。**比 PRD 描述的更严重**：这一步不在事务里，失败时
  `users` 已经被 DROP 并重建为空表，用户行只剩在 `users__ph_mig`；下次启动不再走这一步，`ensureDefaultLocalUser`
  会新建一个本地用户，原用户（及其会话归属）就此丢失。已在副本上复现。
- **修法**：新增 `rebuildTables`，按 SCHEMA_DDL 建表、按列名拷贝（NOT NULL+DEFAULT 列 COALESCE 默认值）、单事务、
  先备份、事后重放索引 DDL。三处重建（password_hash、force_web_search 默认值、FK 删除语义 7 张表）全部改用它。
  `email_verified` / `image` 加进 SCHEMA_DDL 的 users（Drizzle 里早就有），并把加这两列的步骤移到重建之前。
  另加 `recoverInterruptedUsersRebuild`：残留 `users__ph_mig` 时按列名补回缺的用户再删副本。
- **同类问题（审计结果）**：旧的 FK 重建手写的 `messages__migrated` 没有 `updated_at`，`conversations__migrated` 没有
  `scheduled_task_id`；force_web_search 重建还缺 summary / key_facts / scheduled_task_id / project_id / imported_*。
  任何一次触发都会静默删掉这些列的数据。改为 SCHEMA_DDL 派生后已消除；force_web_search 重建挪到
  scheduled_task_id 回填之后。settings 去重的 DELETE 从 SCHEMA_DDL 移出（`dedupeSettings`），先查有无重复，有才备份 + 删。
- **备份时机**：不在启动开头统一判断，而是在第一个破坏性步骤前惰性快照一次（`MigrationBackup.ensure`）。待执行的
  ONE_TIME_MIGRATIONS 和 `rebuildTables` 自动经过它，所以无事可做的启动不拷贝。启动前一张表都没有的新库不备份。
  文件名为 `<库名>-<UTC ISO 时间>-v<迁移前已应用数>.db`；在没有记录表时，这个数取 user_version。
- **user_version 决定：改为 `schema_migrations(id, applied_at)`**（两处 schema 已同步）。记录表为空时把 user_version=n
  折算为前 n 条旧迁移（冻结的 `USER_VERSION_MIGRATION_IDS`），之后不再读 user_version；大于 2 的值不是我们写的，直接忽略
  （两条旧迁移都幂等）。
- **验证（全部在 scratchpad 副本上做，真实库未写）**：
  - 7 月库副本：启动成功，迁移前先备份。1067 条消息全部保留，chat 行正文 0 处变化，非正文列 0 处变化。agent 行有 158 条正文变化：
    82 条原文仍在 content 或 text 步骤里，43 条错误文本移到 agentRun.error，33 条是服务端模板占位语（"Planning
    completed…" / "我会按简要步骤直接开始处理。" / "Execution completed. Tool starts…" / "已生成任务计划…"），被替换为
    任务 final_result 的真实回复，没有 final_result 时置空（38d0a25 的规则）。没有真实回复文字丢失。用户 2/2 保留，各列值正确。
    第二次启动无备份、无变化。和当前库共有的 1051 条里只有 1 条正文不同（同一段 401 文本，一边在 text 步骤、一边在 agentRun.error）。
  - 当前库副本：启动成功、不备份（user_version=2 折算为两条记录）。1294 条消息 0 处变化。
  - 当前库副本（人为改坏 messages FK 和 force_web_search 默认值）：两种重建都执行。消息与会话所有列 0 处差异
    （包括 13 条 updated_at、36 条带 summary / scheduled_task_id / project_id 的会话），integrity_check ok。
  - 旧代码失败一次后的副本：残留在 `users__ph_mig` 的 2 个用户被补回。
  - foreign_key_check 的违规条数前后一致（7 月库 261，当前库 15），都是本任务之前就有的孤儿行。
