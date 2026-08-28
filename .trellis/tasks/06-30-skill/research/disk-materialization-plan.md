# Skill 加载架构改造实现计划（方案 A：内容落盘、通道只传引用）

> 根因：每次 agent.run 把所有启用技能内容(可达70MB)塞进一条 WebSocket 消息 desktop→sidecar，超 WKWebView 发送 / Bun 16MB 接收上限 → connection closed。
> 目标：对齐 Claude Code——内容物化到磁盘一次，agent.run 只传路径+元数据，sidecar 从磁盘读。

## 1. 物化落点
`<sidecarCwd>/.openhorn/skills/<sanitizedName>/`，cwd=state.workspaceRoot。**去掉 per-run 维度**。
- 在 cwd 内 → 过 claude `checkSdkFsToolPath` / direct `path.resolve(cwd,..)` 校验，无需新放行。
- 复用 .openhorn/（已 gitignore）。
- 写方从 sidecar 移到 desktop（仅技能变更时写一次，run 只读）→ 无写写竞争。
- 并发缓解：finalize 用**原子替换**——写到 `.openhorn/skills.tmp-<rand>/`，全写完 rename 到 `.openhorn/skills/`。

## 2. Rust 命令（apps/desktop/src-tauri/src/lib.rs，复用 base64 crate）
按大小预算分批，每 invoke ≤~2MB：
```
struct MaterializeEntry { rel_path: String, content: String, is_binary: bool }
skills_materialize_begin(workspace_root) -> tmpRoot(=<root>/.openhorn/skills.tmp-<rand>)  // 建目录+ensure .gitignore
skills_materialize_batch(tmp_root, entries: Vec<MaterializeEntry>) -> ()                   // 多次调用
skills_materialize_finalize(workspace_root, tmp_root) -> skillsRoot(=<root>/.openhorn/skills)  // 原子替换
skills_materialized_exists(skills_root) -> bool   // 可选，缓存命中时校验目录在
```
- 路径安全：每个 rel_path 校验（拒绝绝对路径/`..`/`\`），canonicalize 父目录 starts_with(tmp_root)（复用 collect_skill_files 守卫思路 lib.rs:876-882）。
- 二进制：is_binary→base64 STANDARD.decode 后写字节；文本直写。与 skill_read_dir 的 encode 对称。
- 注册到 invoke_handler!（lib.rs:1019）。
- Tauri2 IPC 单次 ~2MB 安全（和 WS 单帧 70MB 是两条不同通道）；最大单文件 7.4MB(base64≈9.9MB)单独成批；>~12MB 跳过+warn。

## 3. 缓存（desktop，避免每 run 重写）
hash 存 localStorage key `openhorn.skills.materialized`：
1. `api.skill.listSkills()`(不含content) → enabled 过滤 → 按 id 排序对 `id+updatedAt` 算 SHA-256 hash（仅几KB流量）。
2. cache={hash,workspaceRoot,skillsRoot,metas}；若 hash 一致 && workspaceRoot 一致 && skills_materialized_exists → 跳过写盘，直接用缓存 skillsRoot+metas 发 run。
3. 否则 `api.skill.listEnabled()` 拉全量 → begin/batch/finalize 写盘 → 写回 localStorage。
- workspaceRoot 进 cache key。

## 4. 协议（apps/sidecar/src/protocol.ts）
```
// 删 SkillFilePartSchema(:79-83)
SkillMetaSchema = z.object({ name: z.string().min(1), description: z.string().default(""), dir: z.string().optional() })
// AgentRunParamsSchema(:107) 加：
skillsRoot: z.string().optional(),
skills: z.array(SkillMetaSchema).optional(),
```
desktop 对应：sidecarClient.ts:90-96 类型改元数据+skillsRoot?；:347-369 透传。useSidecarAgentRun.ts:235-274 skills 只放 {name,description}+skillsRoot。

## 5. sidecar 写改读（apps/sidecar/src/agent/skills.ts + index.ts）
skills.ts：删 materializeSkills 写逻辑，新增：
```
resolveSkills(skillsRoot?, metas?: {name;description?;dir?}[]) -> MaterializedSkill[]
// 每个 meta: skillDir=join(skillsRoot, meta.dir ?? sanitizeSkillName(name)); skillMdPath=join(skillDir,"SKILL.md")
// stat(skillMdPath) 成功才纳入(跳过缺失,不抛); description 用 meta.description; 返回 {name,description,skillMdPath,skillDir}
```
保留 sanitizeSkillName/normalizeDescription/MaterializedSkill；**buildSkillsPromptSection 不动**；删写相关辅助(ensureOpenhornGitignored/normalizeRelPath/assertInsideSkillDir/buildSkillMd→迁 Rust)；删 SkillPart/SkillFilePart 类型。
index.ts：:386,401 解构改 skillsRoot+skills(元数据)；:447-454 换 `const safeRoot=resolveSkillsRoot(cwd,skillsRoot); const materializedSkills=usesCodex?[]:await resolveSkills(safeRoot,skills)`；删 skillRunId(:451)；:492 透传不变。
claude.ts/direct.ts **不动**。

## 6. workspace 安全
落点在 cwd 内，read 校验天然通过，8 层防护不动。新增防御：
```
resolveSkillsRoot(cwd, skillsRoot?): string|undefined {
  const expected=path.join(cwd,".openhorn","skills");
  if(!skillsRoot) return expected;
  return path.resolve(skillsRoot)===expected ? expected : undefined; // 不匹配则忽略
}
```

## 7. desktop 控制流（useSidecarAgentRun.startRun 拉技能/发run前，仅 anthropic/openai）
```
root = sidecarStore.workspaceRoot; if(!root) { skills=undefined; 照常发run; }   // /tmp被禁→root为null→跳过技能
manifest hash = sha256(enabled skills id+updatedAt)
if cache 命中: skillsRoot=cache.skillsRoot; metas=cache.metas
else: enabled=listEnabled(); tmp=begin(root); for batch in splitBySize(entries,2MB) batch(tmp,batch); skillsRoot=finalize(root,tmp); metas=enabled.map({name,description}); 写cache
client.runAgent({..., skillsRoot, skills: metas })
```
展平：每技能→{relPath:"<sanitizedName>/SKILL.md", content: 带frontmatter的SKILL.md(desktop TS 拼,原buildSkillMd逻辑), isBinary:false} + 每file→{relPath:"<sanitizedName>/<file.path>", content, isBinary}。

## 8. 风险
1. **/tmp 默认工作目录**：workspace.ts 把 /tmp、/private/tmp 列为禁止 root→workspaceRoot 为 null→cwd 回退 homedir，desktop 不知 cwd。**结论：技能物化要求已选合法 workspaceRoot；未选则跳过技能并提示"选择工作目录以启用技能"**。
2. 首次/变更物化耗时一次性；命中缓存零开销；可显示 loading。
3. finalize 整目录替换→停用技能无残留。
4. 二进制 base64 往返：Rust decode 与 skill_read_dir encode 对称；测含二进制资源(PDF)往返。
5. 缓存信任 updatedAt；可选"重新加载技能"清缓存入口。

## 9. 最小改动集
| 文件 | 改动 |
|---|---|
| desktop src-tauri/src/lib.rs | 新增 skills_materialize_begin/batch/finalize(+exists)；注册；复用base64+symlink守卫 |
| desktop src/lib/tauriBridge.ts | 新增上述命令 TS 包装 |
| desktop src/hooks/useSidecarAgentRun.ts | manifest-hash缓存+分批物化；skills 改 {name,description}+skillsRoot |
| desktop src/lib/sidecarClient.ts | 类型改元数据+skillsRoot?；run参数透传 |
| sidecar src/protocol.ts | 删SkillFilePartSchema；SkillMetaSchema；加skillsRoot |
| sidecar src/agent/skills.ts | materializeSkills→resolveSkills(只读);buildSkillsPromptSection不动;删写辅助 |
| sidecar src/index.ts | 解构改;换resolveSkills+resolveSkillsRoot;删skillRunId |
**不改**：claude.ts、direct.ts、system-prompt.ts、workspace.ts、skillLoader.ts、server。
