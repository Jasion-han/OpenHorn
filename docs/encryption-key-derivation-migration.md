# 加密密钥派生升级方案

> 状态：**已实施**（2026-07-26）
> 关联：`docs/code-review-2026-07-26.md` 中「utils.ts 裸 SHA-256 派生密钥」一项

## 实施结果

采用第 4.4 节的一次性脚本方案，并按第五节第 3 点收敛了重复实现。

- `apps/server/src/utils.ts` — v1/v2 双路解密、v2 加密、派生结果按 secret 缓存
- `packages/shared/src/utils/index.ts` — 删除重复的加解密实现，仅保留 `generateId`
- `apps/server/src/scripts/reencryptChannelKeys.ts` — 迁移脚本，默认 dry-run，`--apply` 才写入
- 新增 12 个测试，含 v1 密文兼容、篡改 tag 拒绝、换 secret 拒绝

**实测数据**：

| 项 | 结果 |
|---|---|
| 迁移前 | 10 条全部 v1，0 解密失败 |
| 迁移后 | 10 条全部 v2，0 解密失败 |
| 明文指纹比对 | **10/10 逐条一致** |
| 首次加解密（含 scrypt 派生） | 62.1 ms |
| 后续每次解密（命中缓存） | 0.009 ms |

实施中发现一处方案未预料到的问题：`N=2^15, r=8` 需要约 33MB，超过 Node/Bun 的 scrypt 默认 `maxmem`（32MB），首次加密即抛 `MEMORY_LIMIT_EXCEEDED`。已显式设 `maxmem: 64MB`。

---

以下为实施前的原始方案。

## 一、现状（已核实）

`packages/shared/src/utils/index.ts` 与 `apps/server/src/utils.ts`：

```ts
function getKey(): Buffer {
  return crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest();
}
```

三个问题，按严重度排：

1. **无 KDF**。裸 SHA-256 是为速度设计的，单次运算。攻击者拿到密文后可以每秒尝试数十亿个 `ENCRYPTION_KEY` 候选值。若该值是人工设定的口令（`.env.example` 里写的是 `replace-with-32-byte-key`，很容易被填成一个短口令），离线爆破成本极低。KDF 的作用正是让每次尝试变慢若干个数量级。
2. **无 salt**。相同的 `ENCRYPTION_KEY` 在任何一台 OpenHorn 部署上都派生出同一个 AES 密钥，可预计算彩虹表。
3. **每次加解密重算**。功能上无害，仅是浪费。

补充：`IV_LENGTH = 16`，而 AES-GCM 的标准 IV 是 12 字节。16 字节会触发额外的 GHASH 派生，非标准但不构成漏洞。

## 二、影响面（已核实，不是估算）

| 项 | 实测结果 |
|---|---|
| 被加密的数据种类 | **仅 1 种** — channel 的 apiKey |
| 加密调用点 | 2 处（`channelService.ts:609` 创建、`:680` 更新） |
| 解密调用点 | 5 处（`channelService.ts` 893 / 1026 / 1151 / 1215 / 1320） |
| 本地库现存密文 | **10 条**（`SELECT COUNT(*) FROM channels`） |

**顺带发现**：`apps/server/src/utils.ts` 与 `packages/shared/src/utils/index.ts` 是**两份逐字重复的实现**。`channelService` 用的是前者；后者当前**无人 import**。若要改，两份必须同时改，否则会出现"一份升级一份没升"的静默不一致——建议借这次把 shared 那份收敛掉，或让 server 那份改为 re-export。

## 三、为什么不能直接换算法

改掉 `getKey()` 会让这 10 条现存密文**全部解不开**，表现为所有已配置渠道立刻失效、且无法恢复（明文只存在于密文里）。所以必须做版本化共存。

## 四、建议方案：版本化密文 + 惰性重加密

### 4.1 密文格式

```
v1（现存）: <iv>:<tag>:<ciphertext>          3 段
v2（新增）: v2:<iv>:<tag>:<ciphertext>       4 段，首段为版本标记
```

`decrypt()` 按段数分派：3 段走旧密钥，4 段且首段为 `v2` 走新密钥。旧密文的 IV 是 16 字节，`createDecipheriv` 依传入 buffer 长度处理，照常可解。

### 4.2 密钥派生

```ts
const V2_SALT = "openhorn.encryption.v2";

function deriveKeyV2(secret: string): Buffer {
  // N=2^15 约 30–60ms/次，足以让离线爆破失去性价比，
  // 又不至于让首次启动有感知延迟。
  return crypto.scryptSync(secret, V2_SALT, 32, { N: 2 ** 15, r: 8, p: 1 });
}
```

**salt 为何固定**：scrypt 故意设计得慢。若每条密文用随机 salt，则每次解密都要付一次 30–60ms，而 `channelService` 在渠道探测等路径上会连续解密多条，会明显拖慢。这里的威胁模型是"主密钥离线爆破"，固定 salt + 慢 KDF 已经消解它；随机 salt 主要防彩虹表跨用户复用，对单一主密钥场景收益有限。

**派生结果进程内缓存**，只在首次加解密时计算一次。

### 4.3 迁移方式：惰性重加密

不写迁移脚本、不停机：

- 新写入的密钥一律 v2
- 解密遇到 v1 时正常解开，**并顺手用 v2 重新加密写回**
- 渠道被读取一次即完成升级；从未被使用的旧渠道保持 v1，仍可解

代价是 `decrypt()` 需要能回写，即调用点要传入"如何持久化"的回调，或由 `channelService` 在解密后判断版本并更新。后者更简单，且解密调用点集中在同一文件的 5 处。

### 4.4 可选：一次性重加密命令

若不接受"惰性"带来的代码复杂度，替代方案是加一个 `pnpm --filter server run reencrypt` 脚本，遍历 channels 表逐条 v1→v2。停机窗口约等于 10 条 × 数十毫秒，可忽略。**代码更简单，但需要人工执行一步**。

## 五、需要你决定的三件事

1. **做不做**。威胁模型是"攻击者已拿到数据库文件 + `ENCRYPTION_KEY` 是弱口令"。若你的部署里 `ENCRYPTION_KEY` 本就是 32 字节随机值，那么裸 SHA-256 的实际风险很低，这项可以不做——**这是唯一真正取决于你的信息**。
2. **惰性重加密（4.3）还是一次性脚本（4.4）**。前者零操作、代码稍复杂；后者代码简单、需手动跑一次。我倾向 4.4：调用点少、数据量小，简单胜过精巧。
3. **要不要顺带收敛那两份重复的 utils**。我建议收敛——否则这次改完，将来有人 import 了 shared 那份，会写出用旧算法加密的数据，而且不会报错。

## 六、若决定实施

预计改动：
- `apps/server/src/utils.ts`：v1/v2 双路解密 + v2 加密 + 派生缓存
- `packages/shared/src/utils/index.ts`：改为 re-export 或删除
- 新增 `reencrypt` 脚本（若选 4.4）
- 测试：v1 密文可解、v2 往返、v1→v2 迁移后可解、错误 tag 应失败、缺 `ENCRYPTION_KEY` 应报错

工作量约 1 小时，含测试与实测验证（用真实库的 10 条数据跑一遍迁移前后可解性）。
