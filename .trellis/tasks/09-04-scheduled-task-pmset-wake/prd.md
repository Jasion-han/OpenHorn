# 定时任务:合盖睡眠也能准点触发(本地唤醒,无云、暂不签名)

## Goal

让定时任务在 Mac 合盖/睡眠时也能准点触发执行,方案随 App 分发给其他用户在他们的 Mac 上生效,全程不依赖云服务器。当前 server(时钟)/desktop/sidecar(执行)全在本机,Mac 一睡整链路停,到点任务被标记「客户端当时不在线,已错过执行时间」。

## 关键事实(research 已验证)

* **睡眠时 App 进程只是被冻结,不是被杀。** `pmset` 把机器唤醒后,后台的 App 自动恢复,现有 B 逻辑(server 建 pending run → desktop 认领 → sidecar 执行)接着跑。→ MVP 只需负责「把机器唤醒」+「醒后顶住别再睡」。
* **pmset 必须 root,无免权限唤醒 API。** 不签名 → 走 `osascript ... with administrator privileges`,注册/刷新唤醒计划时弹一次密码框(可批量:一次 do shell script 排多个唤醒)。签名后 → 可升级 SMAppService 特权 helper,授权一次永久静默(留接口,本任务不做)。
* **必须用 `pmset schedule wake`(一次性、可叠加、带 owner 标记),绝不用 `repeat`/`cancelall`**,否则冲掉用户自己的电源计划。schedule 事件持久化、跨重启保留。
* **合盖唤醒的真实边界**:RTC 闹钟不管开合盖都触发,但通常是短暂 dark/maintenance wake。**插电(或 clamshell 接显示器)+ 醒后立刻抓电源锁 → 可靠;纯电池合盖装包 → 尽力而为,不保证**(`caffeinate -s` 仅 AC;电池下只有 `-i`/IOPMAssertion 空闲防睡)。
* research 文件:research/pmset-wake-scheduling.md、research/wake-alternatives.md。

## Decision (ADR-lite)

* **Context**:用户无云服务器、纯笔记本,要「合盖也能跑」且能分发;暂不做 Apple 签名+公证。
* **Decision**:做 **B(诚实降级,醒着就跑)为基线 + A-unsigned(pmset schedule wake 本地自唤醒)为增强**。A 用 osascript 管理员授权(注册唤醒批量弹一次密码),醒后用电源锁顶住执行期。签名版特权 helper 留作后续,仅预留接口。
* **Consequences**:插电合盖可准点跑;电池装包不保证(如实提示);开启功能/刷新唤醒计划会弹密码;App 需保持后台运行。

## Requirements

* R1 新增 Tauri(Rust)命令:批量注册未来一段时间(默认 14 天)所有 enabled 任务执行时刻为 `pmset schedule wake` 事件,带 owner 标记 `openhorn`;一次 osascript 授权覆盖整批。
* R2 新增 Tauri 命令:列出/清理本 App(owner=openhorn)注册过的唤醒事件,不触碰用户其他事件;关闭功能或退出可干净还原。
* R3 desktop 侧:任务变更(建/改/开关/删)后重算唤醒窗口并刷新注册;滚动窗口(临近耗尽时再补,尽量少弹密码)。
* R4 醒后顶住:执行开始时抓电源锁(`caffeinate -i -w <pid>` 或 IOPMAssertion),跑完/超时释放。
* R5 设置项开关:「合盖也执行定时任务(需授权)」默认关;开启时说明前提(建议插电、需管理员授权、电池不保证)。UI 文案走 i18n。
* R6 不破坏 Mac 醒着时的原有行为(B 基线不回归)。

## Acceptance Criteria

* [ ] 开启功能后,注册的唤醒事件能在 `pmset -g sched` 中看到且带 owner 标记。
* [ ] **本机合盖(插电)实测**:到点机器自动唤醒且任务成功执行,run 状态 completed(附时间戳证据,非「应该」)。
* [ ] 关闭功能 / 清理后,`pmset -g sched` 中本 App 的事件被移除,用户其他事件不受影响。
* [ ] 电池合盖场景如实提示「不保证」,不谎报成功。
* [ ] Mac 醒着时原有定时执行不回归。
* [ ] typecheck / biome 绿;Rust 侧 `cargo check` 通过。

## Definition of Done

* 本机合盖(插电)实测通过 + 证据;electron 无关。
* Rust 命令有错误处理(授权取消、pmset 失败);desktop 侧 i18n 文案齐全。
* 文档:开启需要什么授权、如何关闭还原、边界说明。

## Out of Scope

* Apple 签名 + 公证、SMAppService 特权 helper 的实现(仅预留接口/后续任务)。
* 云端/自托管执行(SaaS 化)。
* Windows/Linux 等价机制。

## Research References

* [research/pmset-wake-scheduling.md](research/pmset-wake-scheduling.md) — pmset schedule/repeat 语义、root 成本、防冲突注册、Rust 命令串、醒后保活。
* [research/wake-alternatives.md](research/wake-alternatives.md) — launchd/pmset/IOKit/BGTask 对比与"可分发产品"取舍矩阵。

## Technical Notes

* Tauri Rust:`apps/desktop/src-tauri/src/lib.rs` 已有 `#[tauri::command]` + `std::process::Command` 先例(open/xdg-open),照此加命令并注册进 `generate_handler!`。
* desktop 执行链:`apps/desktop/src/lib/backgroundTaskRunner.ts`(armDueTimer / sweep / execute)。
* i18n:`apps/desktop/src/lib/i18n/agent.ts`(scheduledTask.* 已有一批)。
* 验证:改挂载期逻辑需整树重启桌面端([[project-tauri-dev-reload-and-logs]]),DB 轮询 scheduled_task_runs 看 status/时间戳。
