# Research: Alternatives to `pmset` for waking/running a scheduled task in a distributable macOS Tauri app

- **Query**: Compare mechanisms (launchd, pmset, IOKit power assertions/caffeinate, NSBackgroundActivityScheduler/BGTaskScheduler, what shipping apps use) for running a scheduled background task on a downloadable Tauri app even with the lid closed / machine asleep. Provide a comparison table + recommendation matrix. Address whether "wake the Mac locally" is fundamentally reliable without a cloud server.
- **Scope**: external (macOS platform mechanisms) — no OpenHorn code currently implements any of these (`grep` for `pmset|caffeinate|IOPMAssertion|StartCalendarInterval|LaunchAgent` across `apps/` and `packages/` returned nothing).
- **Date**: 2026-09-04
- **Sibling doc**: pmset scheduled-wake specifics are covered separately in this task's research folder (referenced here as `./pmset-scheduled-wake.md` — see the pmset column below; not duplicated). If that file does not yet exist, it is the expected companion doc for the pmset deep-dive.

> Evidence note: External web fetch tools (exa/WebSearch) were not available in this session. The findings below come from the canonical Apple man pages (`launchd.plist(5)`, `pmset(1)`, IOKit `IOPMLib.h`), Apple's Energy/Power documentation, and published vendor docs (Carbon Copy Cloner, Amphetamine). Behaviors described are long-stable macOS fundamentals. Where a claim is version-/hardware-sensitive (esp. Apple Silicon power-on, clamshell on battery), it is flagged in **Caveats** and should be re-verified against live docs before implementation.

---

## TL;DR

- **No public, no-root API keeps a Mac awake or wakes it on a schedule with the lid closed on battery.** That is a deliberate macOS constraint, not a missing feature.
- The only mechanism that actually **wakes a sleeping Mac at a chosen time** is **`pmset schedule`/`pmset repeat` wake events — and those require root/admin.** Power assertions / `caffeinate` only *prevent* idle sleep while awake; they do not wake, and they do not beat lid-close (clamshell) sleep.
- **launchd `StartCalendarInterval`** does **not** wake the machine; if the Mac is asleep at fire time, the job is deferred and run **once on next wake** (catch-up). It survives app-not-running (that's its whole point) and needs no root when installed as a **LaunchAgent** in `~/Library/LaunchAgents`.
- **BGTaskScheduler is not applicable** to a non-App-Store AppKit/Tauri Mac app; **NSBackgroundActivityScheduler** is in-process only (dies with the app, never wakes from sleep).
- **The robust combination for a local-only product** is: `pmset repeat wakeorpoweron` (root, one-time install) **to wake the machine** + a **LaunchAgent `StartCalendarInterval`** (or the running app) **to do the work on wake**. This is exactly what backup tools ship.
- **Honest strategic answer:** for a downloadable app with no cloud server, "wake the Mac locally" is *usable but not fundamentally reliable* (battery + clamshell + Apple-Silicon power-on caveats + single-wake-schedule contention). For guaranteed execution, a **lightweight always-on component** (the user's own always-on/plugged-in Mac, or an optional self-hosted trigger) is the only robust answer. Recommendation matrix at the bottom.

---

## Findings

### 1. launchd LaunchAgent + `StartCalendarInterval`

Source of truth: `man launchd.plist`, `man launchctl`, Apple "Creating Launch Daemons and Agents".

- **Install location / privilege**: `~/Library/LaunchAgents/<label>.plist`. **No root required** — a LaunchAgent runs in the user's GUI session under the user's uid. (A LaunchDaemon in `/Library/LaunchDaemons` runs as root at boot and *does* need admin to install.)
- **Fires with lid closed / machine asleep?** **No, not while asleep.** `StartCalendarInterval` is a wall-clock trigger evaluated by launchd; launchd does **not** wake the machine. If the scheduled time elapses while the Mac is asleep, the job does **not** run at that instant. On the **next wake**, launchd runs the missed job **exactly once** (it coalesces multiple missed intervals into a single catch-up run — you do *not* get one run per missed slot).
- **So when does it fire with the lid closed?** Only when the machine is actually **awake** with the lid closed — i.e. clamshell mode on AC with an external display, or during a window where something else woke the machine (Power Nap, a `pmset` scheduled wake, a user, etc.).
- **Can it be combined with a `pmset` wake to actually run on schedule while asleep?** **Yes — this is the intended pattern.** `pmset` wakes the machine at time T; the machine coming out of sleep causes launchd to evaluate/run the `StartCalendarInterval` job (or a `StartInterval` job, or you fire the app). Timing subtlety: schedule the launchd job a minute or two *after* the `pmset` wake so the system is fully up and networked before the job runs. This is the classic "wake + run" recipe.
- **Survives app-not-running?** **Yes.** The whole value of a LaunchAgent is that launchd (not your app) owns the schedule; the target app/script is launched on demand. This is its key advantage over any in-process scheduler.
- **Distribution/UX cost**: Your app must **write the plist and `launchctl bootstrap`/`load` it** into the user session on first run. No admin prompt for a LaunchAgent. Signing/notarization of the launched binary still applies. Under App Sandbox this is restricted, but a Tauri app is typically **not** sandboxed for direct distribution, so writing to `~/Library/LaunchAgents` is fine. Low friction.
- **Reliability**: High **for the "run on/after wake" role**; **zero** for "wake the machine" (it can't). It also silently defers to catch-up on wake, which for a "run every day at 3am" feature means "runs at 3am only if awake, otherwise at next wake" unless paired with a wake source.

### 2. `pmset` scheduled wake (see sibling doc) + launchd or app timer

Full detail in the sibling pmset research doc. Summary of how it slots into this comparison:

- **`pmset schedule wake "MM/DD/YY HH:MM:SS"`** (one-shot) and **`pmset repeat wakeorpoweron <days> HH:MM:SS`** (recurring) register a hardware RTC wake with the SMC/power controller. This is the **only** listed mechanism that **wakes a sleeping Mac (lid closed, on battery or AC) at a chosen time**.
- **Requires root/admin.** `pmset schedule`/`pmset repeat` modify system power scheduling and must run via `sudo`/an authorized helper. This is the main per-user friction point for a downloadable app (you need an admin auth prompt or a privileged helper tool installed via `SMJobBless`/`SMAppService`).
- **Contention**: There is effectively a **single repeating wake schedule** managed by the system (shared with Energy Saver's "Schedule…" UI and any other app that calls `pmset repeat`). Last writer wins — your app can clobber, or be clobbered by, the user's own schedule or another app's.
- **`wakeorpoweron` from full shutdown**: historically works on Intel; **unreliable / not supported on Apple Silicon for power-on from S5**. Wake-from-sleep is the dependable case. (Flagged — re-verify per current hardware.)
- **Pairing**: `pmset` only *wakes* the machine; it does not run your code. You still need launchd (Recipe A) or your always-launched app (Recipe B) to do the work in the wake window. macOS also tends to return to sleep quickly after an RTC wake unless you hold a **power assertion** for the duration of the job (see §3).

### 3. IOKit power assertions (`IOPMAssertionCreateWithName`) & `caffeinate`

Source of truth: `IOKit/pwr_mgt/IOPMLib.h`, `man caffeinate`, Apple "Power Management" notes.

- **What they do**: Assertions like `kIOPMAssertionTypePreventUserIdleSystemSleep` (system won't *idle*-sleep), `kIOPMAssertionTypePreventUserIdleDisplaySleep` (display stays on), and the private/legacy `PreventSystemSleep` **prevent the machine from going to sleep while it is already awake**. `caffeinate` is the command-line front-end (`caffeinate -s` = prevent system sleep on AC; `-i` = prevent idle sleep; `-d` = prevent display sleep; `-u` = simulate user activity).
- **Do they wake a sleeping Mac?** **No.** Assertions can only be *created/held while the process is running and the machine is awake.* They are a "stay awake," never a "wake up." No relevance to the asleep case.
- **Can they keep the Mac awake with the LID CLOSED?** **This is the critical limitation:**
  - **On battery, lid closed → the Mac sleeps regardless of any assertion.** Closing the lid triggers **clamshell sleep**, which is a forced sleep that public power assertions **do not override**. `caffeinate` does *not* beat lid-close on battery.
  - **On AC power, lid closed → stays awake only in "clamshell mode"**, i.e. when an **external display plus external keyboard/mouse (or the setting allowing it)** are present. That is Apple's supported "closed-display operation." Without an external display, closing the lid sleeps even on AC.
  - **There is no public API to prevent lid-close sleep by itself.** The only way to keep a Mac awake with the lid closed and no external display is **`sudo pmset -a disablesleep 1`** (root; global; affects the whole system until reset) — which is what "closed-display" utilities effectively toggle. So this path is (a) root and (b) heavy-handed / user-hostile.
- **Role in the recipe**: The legitimate use is to **hold `PreventUserIdleSystemSleep` for the duration of your job** *after* a `pmset` wake, so the machine doesn't fall back asleep mid-task, and to keep the machine up while the lid is open. It is a *complement* to `pmset`, not a substitute.
- **Privilege / UX**: Creating assertions needs **no root** and no user prompt. `caffeinate` is built-in. Low friction — but limited to the "already awake" window, and useless for lid-closed-on-battery.

### 4. NSBackgroundActivityScheduler / BGTaskScheduler

Source of truth: Foundation `NSBackgroundActivityScheduler`, BackgroundTasks `BGTaskScheduler` docs.

- **BGTaskScheduler**: iOS/iPadOS/tvOS/watchOS (and Mac **Catalyst**) API. **Not available to a normal AppKit/Tauri Mac app.** It is opportunistic/best-effort, heavily throttled by the OS, requires registered task identifiers in the app's Info.plist, and — critically — is designed around App Store distribution and **does not wake the device from sleep** on a user's schedule. **Not usable here.**
- **NSBackgroundActivityScheduler**: the macOS-native (Foundation) API for repeating maintenance work. Usable from a Mac app in principle, **but**:
  - It is **in-process** — it lives inside your running app. **Dies when the app quits.** Does **not** survive app-not-running.
  - It is **opportunistic and deferrable** by design: you give it a tolerance window; the OS decides *when* within that window to run, deferring while on battery / thermally constrained / user-active. You **cannot** demand "exactly 3:00am."
  - It **does not wake the Mac from sleep.** It only schedules work for when the system is already awake and conditions are favorable (it cooperates with, and is subordinate to, power management — it's essentially a polite wrapper over DAS/CTS).
- **Verdict**: Wrong tool for "reliable scheduled task that fires when the app isn't running / the machine is asleep." Fine only for low-priority housekeeping while the app is open.

### 5. What comparable shipping Mac apps actually use

- **Carbon Copy Cloner (Bombich)** — documents that it schedules backups via a **launchd** helper and, to run while the Mac would otherwise be asleep, **registers a `pmset`/IOKit wake event** ("Carbon Copy Cloner will wake or power on your Mac to run this task") and then holds a **power assertion** to keep the Mac awake for the duration. CCC also explicitly warns users that on **battery** / **lid-closed laptops** scheduled wake is unreliable and recommends AC power. → the exact **pmset-wake + launchd + assertion** recipe.
- **SuperDuper! / ChronoSync / Time Machine** — Time Machine (`backupd`) rides Apple's **DAS/CTS scheduler + Power Nap / maintenance wakes** (Apple-internal, not third-party APIs) and RTC maintenance wakes to run hourly backups during sleep on supported hardware. Third-party tools cannot use DAS/CTS directly; they fall back to launchd + pmset.
- **Amphetamine / Caffeine / KeepingYouAwake** — pure **IOKit power assertions** (`PreventUserIdleSystemSleep`). Amphetamine's "closed-display mode" documents that keeping a laptop awake with the lid shut **requires AC power (and often an external display)** and can cause overheating; it cannot do lid-closed-on-battery. Confirms the §3 clamshell constraint.
- **Hazel / cron-style automation** — run as a **launchd LaunchAgent** background helper; only act while the Mac is **awake** (no self-wake).
- **Backup/AI schedulers with a server component (e.g. anything with a companion cloud/self-hosted trigger)** — sidestep the whole problem by triggering work **over the network** from an always-on machine, rather than relying on the laptop to wake itself.

---

## Comparison table

| Mechanism | Fires with lid CLOSED? | Fires while ASLEEP? | Wakes the Mac? | Root/admin? | Survives app-not-running? | Per-user distribution/UX cost | Reliability for "scheduled task on a laptop" |
|---|---|---|---|---|---|---|---|
| **launchd LaunchAgent + `StartCalendarInterval`** | Only if machine is otherwise awake (clamshell AC+display, or woken by something else) | No — deferred, runs **once** as catch-up on next wake | **No** | **No** (LaunchAgent in `~/Library`) | **Yes** | Low — write plist + `launchctl bootstrap` on first run | High as the *runner*; can't guarantee on-time without a wake source |
| **`pmset schedule`/`repeat` wake** (sibling doc) | **Yes** | **Yes — wakes it** | **Yes** | **Yes (root)** | Yes (schedule lives in firmware/OS) | High — needs admin auth or privileged helper (`SMAppService`) | Good *as the waker*; single-schedule contention; battery/Apple-Silicon caveats |
| **`pmset` wake + LaunchAgent + power assertion** (combo) | **Yes** | **Yes** | **Yes** | **Yes (root, for pmset part)** | **Yes** | Highest local-only friction (admin once) | **Best local-only option**; still limited on battery / clamshell / AS power-on |
| **IOKit power assertions / `caffeinate`** | Only AC + external display (clamshell); **never on battery**; lid-only requires `pmset disablesleep`=root | No | **No** | No (assertions) / **root** for `disablesleep` | No (dies with holding process) | Low | Only "stay awake while running"; complements pmset, can't schedule/wake |
| **NSBackgroundActivityScheduler** | No self-wake; opportunistic when awake | No | No | No | **No** (in-process) | Low | Poor — deferrable, in-process, can't hit exact times |
| **BGTaskScheduler** | N/A | No | No | No | No | N/A on AppKit/Tauri | **Not applicable** to non-App-Store Mac app |

---

## Recommendation matrix (for a downloadable, cloud-less Tauri product)

| Your situation / requirement | Recommended mechanism | Why |
|---|---|---|
| Task must run **exactly on time even if the Mac is asleep**, product is desktop-plugged-in (Mac mini / iMac / laptop on AC at a desk) | **`pmset repeat wakeorpoweron` + LaunchAgent `StartCalendarInterval` (+ power assertion during job)** | Only combo that truly wakes + runs unattended. Fine on AC. |
| Same, but on a **laptop that lives on battery with the lid closed in a bag** | **Do not promise local scheduling.** Offer: run only when awake/plugged-in, *or* an **optional always-on trigger** (self-hosted server / the user's other always-on Mac) | OS forces clamshell sleep on battery; no public API defeats it. Any "it'll wake itself" promise will silently fail. |
| You want **zero admin prompts** | **LaunchAgent `StartCalendarInterval` only** (no pmset) | No root. Accept the semantics: "runs at time T if awake, else at next wake." Good enough for daily digests, not for hard deadlines. |
| You only need the task to run **while the app/user is active** | **NSBackgroundActivityScheduler** or a plain in-app timer + a **power assertion** to avoid idle-sleep mid-task | Simplest; no persistence needed. |
| You need **guaranteed, timezone-correct, always-fires** execution (SLA-like) | **Lightweight always-on component**: optional self-hosted OpenHorn server / cron on an always-on box that triggers the sidecar over the network | The honest answer — see below. |

### The honest strategic conclusion

For a downloadable app with **no cloud server**, "wake the Mac locally and run the task" is **usable but not fundamentally reliable**:

- **On AC with lid open, or clamshell + external display**: reliable via `pmset` wake + launchd + assertion. This is genuinely good.
- **On battery / lid closed / in a bag**: **not reliable, by OS design.** Clamshell sleep on battery cannot be prevented without root-level `pmset disablesleep`, and even scheduled RTC wakes are curtailed on low battery; Apple-Silicon power-on-from-off is unreliable.
- **Contention & privilege**: the wake schedule is a single shared resource, and setting it needs admin — real friction and real "it stopped working because another app/the user changed the schedule" failure modes.

**Therefore:** ship the **`pmset` wake + LaunchAgent + assertion** recipe as the best-effort local path (with an admin auth on setup and clear UX that it works best on power), **but** for users who need dependable scheduled agent runs, the only robust design is a **lightweight always-on component** — the user's own always-on/plugged-in machine acting as the scheduler, or an **optional self-hosted OpenHorn server** that triggers the sidecar over the network. A laptop that sleeps in a bag will never be a dependable cron host, no matter which API is chosen.

---

## Caveats / Not Found

- **No live web fetch this session** — exa/WebSearch tools were unavailable. Claims are from canonical man pages / SDK headers / known vendor docs. Re-verify the following against current Apple docs before implementation:
  - **Apple Silicon**: `pmset` `wakeorpoweron` power-on-from-shutdown reliability; whether wake-from-sleep RTC scheduling differs on M-series vs Intel.
  - **launchd catch-up semantics**: confirm the "coalesce missed `StartCalendarInterval` runs into one on wake" behavior on the target macOS version (stable historically; worth a spot check).
  - **`pmset disablesleep`** availability/behavior on the latest macOS (has been the only lid-closed-on-battery override; confirm still present).
  - **Privileged helper install path**: modern approach is `SMAppService` (macOS 13+) for daemon/agent registration and for running the `pmset` step via a privileged helper; older `SMJobBless`/authorization-services path is deprecated. Confirm which to target.
- **Exact vendor doc URLs** (Carbon Copy Cloner scheduled-wake page, Amphetamine closed-display page, Apple "Creating Launch Daemons and Agents", `NSBackgroundActivityScheduler` / `BGTaskScheduler` reference) were **not fetched** — cited by name. Pull live URLs when writing the spec.
- **Sibling pmset doc** (`./pmset-scheduled-wake.md`) was **not present** in the research folder at time of writing; the pmset column here is a summary pointer, and the deep-dive (exact command syntax, schedule inspection via `pmset -g sched`, contention handling) belongs in that companion doc.
- **OpenHorn code**: no existing usage of any of these mechanisms in `apps/` or `packages/` — this is greenfield for the app.
