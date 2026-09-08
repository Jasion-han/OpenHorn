# Research: Waking a sleeping Mac at a scheduled time from a distributable desktop app (pmset)

- **Query**: How can a downloadable macOS desktop app (Tauri/Electron) wake the Mac from sleep at a scheduled time to run a background task, even with the lid closed? Cover pmset schedule vs repeat, privilege cost, clobbering risk, invocation from Rust, and holding the machine awake.
- **Scope**: mixed (internal context in this repo + external macOS mechanism research)
- **Date**: 2026-09-04
- **Primary authoritative source**: local `man pmset` (macOS, `/usr/bin/pmset`) and `man caffeinate` (`/usr/bin/caffeinate`), read on this machine. Secondary: Apple Developer docs (SMAppService), DssW pmset reference, Apple StackExchange / Apple Community / MacScripter threads (corroboration only).

---

## TL;DR verdict (read this first)

Waking the Mac from sleep at a scheduled time from a *downloadable* app is **technically possible but carries a hard, unavoidable per-user privilege cost**, because **every `pmset` mutation requires root** (`man pmset`: "pmset must be run as root in order to modify any settings"). There is **no unprivileged API** to schedule a wake.

Two shippable options, with different cost:

1. **Cheap-to-build, ugly-per-use**: shell out to `pmset schedule wake` wrapped in `osascript ... with administrator privileges`. Works, but the macOS admin password dialog **re-appears on every schedule change** (no durable cross-invocation caching). For a task that re-arms a one-off wake before each sleep, that is a password prompt every day — unacceptable UX for a shipped product.

2. **Expensive-to-build, clean-per-use**: install a **privileged helper LaunchDaemon** via **`SMAppService`** (macOS 13+; older `SMJobBless` is deprecated). User authorizes **once** at install; thereafter the app talks to the root daemon over XPC and the daemon runs `pmset` with **no further prompts**. This is the only path that is acceptable long-term for a distributed app, and it requires the app to be **Developer ID signed + notarized** with the matching `SMPrivilegedExecutables` / code-signing-requirement plumbing.

Even after the Mac wakes, there is a **second, physical caveat that no code fully removes**: a scheduled wake with the **lid closed on battery** typically produces a short **"dark wake" / maintenance wake**, and the system tends to return to sleep within seconds-to-a-couple-minutes unless a power assertion is held immediately. On **AC power** with lid closed (clamshell), holding an assertion reliably keeps it awake. On **battery + lid closed**, behavior is hardware/OS-version dependent and is the weakest link.

So: **viable on AC (desk/clamshell/plugged laptop) — reliable. On battery + lid closed — best-effort, not guaranteed.** Build option 2 (SMAppService helper) if this ships to end users.

---

## Repo context (why this research exists)

Current scheduling is a pure in-process timer; it does NOT wake the machine.

| File | Role |
|---|---|
| `apps/server/src/services/scheduledTaskScheduler.ts` | Server is "the clock": a `setTimeout` loop (`MAX_SLEEP_MS = 60_000`) finds due tasks, creates a conversation + a `pending` run, calls `advanceNextRunAt`. Only fires while the server process runs and the Mac is awake. |
| `apps/desktop/src/lib/backgroundTaskRunner.ts` | Desktop claims the `pending` run and executes it through the same pipeline as a typed message. Requires the desktop app to be alive. |
| `apps/server/src/services/scheduledTaskService.ts` | `getDueTasks` / `advanceNextRunAt` / run lifecycle. |
| `apps/desktop/src-tauri/src/lib.rs` | Tauri Rust side. Already uses `std::process::Command` (e.g. line ~1233 `Command::new("open")`). No `pmset`/`caffeinate`/`IOPMAssertion` usage yet — this is where a wake-scheduler command would live. |

Gap: nothing wakes the Mac. If the laptop is asleep at `nextRunAt`, both the server timer and the desktop runner are frozen; the task fires late (on next wake) or not at all. That is the problem `pmset schedule wake` would address.

---

## 1. `pmset schedule wake` vs `pmset repeat wake`

Source: `man pmset` (SCHEDULED EVENT ARGUMENTS), verbatim key sentences quoted.

### Semantics

- **`pmset schedule`** = **one-time** power events. Synopsis: `pmset schedule [cancel | cancelall] type date+time [owner]`.
  - `type` ∈ `sleep | wake | poweron | shutdown | wakeorpoweron`.
  - `date+time` format is **`"MM/dd/yy HH:mm:ss"`** (24-hour, **must be quoted**).
  - `owner` is an optional free-text string "describing the person or program who is scheduling this one-time power event" — used to label/identify your events in the list.
- **`pmset repeat`** = **daily/weekly recurring** power on/off. Synopsis: `pmset repeat type weekdays time`, `weekdays` a subset of `MTWRFSU`.
- **`pmset relative [wake | poweron] seconds`** exists for sleep-cycling: wake N seconds after sleep begins. Man page warning: this event **"cannot be cancelled and is inherently imprecise."** Not suitable for "wake at 7:00am".

### Can multiple one-off wake events be queued?

- **`schedule`: YES — multiple one-time events can be queued** simultaneously. `pmset -g sched` lists them all; each `schedule wake` adds an entry. (Corroborated by Apple StackExchange "Schedule multiple wake up times for Mac?" and DssW's pmset reference.) There is a practical ceiling on how many the system retains (historically small, on the order of a handful to ~10s of entries), so treat the queue as "a few upcoming wakes," not "hundreds."
- **`repeat`: NO — there is exactly ONE repeating pair, system-wide.** Man page: *"you may only have one pair of repeating events scheduled — a 'power on' event and a 'power off' event."* Setting a new repeat **replaces** the previous one. This is the clobbering hazard (see §3).

### Persistence across reboots

- **YES.** Man page FILES section: *"All changes made through pmset are saved in a persistent preferences file (per-system, not per-user) at `/Library/Preferences/SystemConfiguration/com.apple.PowerManagement.plist`."* Both `schedule` and `repeat` entries survive reboot. The wake alarm is programmed into the RTC/firmware, so it fires even if macOS was fully powered off (`poweron`/`wakeorpoweron`).

### Does a wake fire with the lid CLOSED (clamshell)? Battery vs AC

This is the load-bearing real-world question. Summary of the evidence:

- **The RTC alarm itself fires regardless of lid state** — it is a firmware timer, independent of whether the lid is open. So "the Mac wakes at the scheduled time with the lid closed" is generally **true** on both AC and battery.
- **BUT what you get is usually a "dark wake" (a.k.a. maintenance wake), not a full wake** (see next subsection). The machine powers CPU + a limited subset of the system for a short, bounded interval, then goes back to sleep.
- **AC + lid closed (clamshell):** reliable. macOS is designed to stay up for background/maintenance work on AC; holding a power assertion the moment you wake keeps it awake for the whole task. This is the strong case.
- **Battery + lid closed:** **weakest, hardware/version dependent.** Community consensus (Reddit r/MacOS, MacPowerUsers) is that a MacBook on battery with the lid closed is aggressive about staying/returning to sleep, and a scheduled wake often yields only a brief dark wake. It can still run a *short* background task if an assertion is grabbed instantly, but "reliably run a multi-minute agent task on battery with the lid shut" should be considered **not guaranteed**.

> Confidence: RTC-fires-regardless-of-lid = high. Exact battery+clamshell awake-duration = medium (varies by Mac model, Intel vs Apple Silicon, macOS version, Power Nap / Low Power Mode settings). Test on target hardware.

### What "dark wake" / "maintenance wake" means for whether OUR process gets CPU

- **Full wake**: user-facing wake (display on, everything runs) — what you get when you open the lid or press a key.
- **Dark wake / maintenance wake**: the system wakes with **display off** and only a **restricted set of processes** scheduled to run (Power Nap-style: mail fetch, Time Machine, software update checks, and processes that registered for background activity). It is **short and bounded** — the system returns to sleep quickly unless something extends it.
- **Implication for OpenHorn**: a normal GUI app (Tauri window) that was merely running before sleep is **not guaranteed CPU during a dark wake** — dark wake is curated. The robust pattern is: the wake is caused by `pmset schedule wake`, and a **root LaunchDaemon** (which the OS *will* run) fires on that wake, **immediately takes an `IOPMAssertion` (or spawns `caffeinate`)** to escalate/hold the machine awake, then drives the work (or signals the GUI app / sidecar to). Relying on the GUI app alone to "just be there and get CPU" during dark wake is fragile.

---

## 2. Privilege requirement & how to pay it once instead of every time

### Does scheduling a wake require root/admin?

**Yes, unconditionally.** `man pmset`: *"pmset must be run as root in order to modify any settings."* `schedule` and `repeat` are modifications. A non-root `pmset schedule wake ...` fails with a permission error. There is **no per-user, unprivileged** wake-scheduling API on macOS. (`-g sched` **reading** the schedule does NOT need root — only mutations do.)

### Option A — `osascript ... with administrator privileges` (the easy path)

```applescript
do shell script "/usr/bin/pmset schedule wake \"09/05/26 07:00:00\"" with administrator privileges
```

- This triggers the standard macOS **authentication dialog** (Touch ID / admin password). It elevates via `AuthorizationExecuteWithPrivileges`-style mechanics.
- **Does the prompt recur every time?** **Effectively yes, for a shipped app.** Corroborated by MacScripter ("do shell script with administrator privileges still asks for pass") and multiple Apple StackExchange/Community threads:
  - Within a **single** `osascript`/AppleScript execution, the granted authorization is cached briefly (historically ~5 min) so *repeated* `do shell script ... with administrator privileges` calls **inside the same run** don't re-prompt.
  - Across **separate process invocations** (i.e., each time your app re-arms a wake, minutes/hours/days apart), the cache is gone → **the user is prompted again**.
  - Embedding the password in the script (`do shell script "..." password "..." with administrator privileges`) avoids the prompt but is a **security anti-pattern** (plaintext admin password in your app) and will fail App review / notarization scrutiny; do not ship it.
- **Net:** fine for a one-off "power user" script; **not acceptable** for a downloadable app that re-schedules wakes regularly, because it means a password prompt per schedule change.

### Option B — Privileged helper installed once (the shippable path)

Install a **root LaunchDaemon** ("privileged helper tool") that runs `pmset` on the app's behalf. The user authorizes **once** (at install/enable), then all future schedule changes go through XPC with **no prompt**.

- **Modern API: `SMAppService`** (macOS 13 Ventura+). Apple Developer: *"In macOS 13 and later, use `SMAppService` to register and control LoginItems, LaunchAgents, and LaunchDaemons as helper executables for your app."*
  - You bundle a daemon `.plist` under `Contents/Library/LaunchDaemons/` and the executable under `Contents/MacOS/` (or `Contents/Library/...`), then call `SMAppService.daemon(plistName:).register()`. First registration prompts the user once (approval in System Settings > Login Items / Background). The daemon then runs as **root** and can call `pmset` freely.
  - The app ↔ daemon channel is **XPC** (or a Unix socket); the daemon validates the caller's code signature before acting.
- **Legacy API: `SMJobBless`** (deprecated in macOS 13, still works for older targets). Reference implementation: `github.com/trilemma-dev/SwiftAuthorizationSample` (SMJobBless + XPC). Newer walkthroughs: `theevilbit.github.io/posts/smappservice/`, `dev.to/brysontyrrell/macos-apps-with-embedded-daemons`.
- **Requirements / cost to build this:**
  - App must be **Developer ID signed and notarized** (a downloadable, non-App-Store app can do this; ad-hoc/unsigned cannot install a privileged helper cleanly).
  - Correct entitlements + `Info.plist` `SMPrivilegedExecutables` / launchd plist `AssociatedBundleIdentifiers` + code-signing-requirement strings that pin the daemon to your Team ID (mutual code-signature validation). Getting these strings exactly right is the main friction (see StackOverflow "SMAppService fails with 'Operation not permitted'").
  - This is **non-trivial Rust/Swift + packaging work** in a Tauri app: you'd ship a small signed Swift/ObjC (or Rust) daemon binary inside the `.app` bundle and register it. Tauri does not do this for you.

> Recommendation for a distributable app: **Option B (SMAppService privileged daemon)**. Pay one authorization at first enable; every subsequent `pmset schedule wake` is silent. Option A is only acceptable as a stop-gap or for a "developer mode."

### Alternative that avoids root entirely (worth noting)

If the requirement can be relaxed from "wake a *sleeping/lid-closed* Mac" to "run a task while the Mac is *awake or lightly idle*," then **`IOPMAssertion` / `caffeinate` need no privilege** (any user can prevent idle sleep). You cannot *wake* from full sleep without root, but you *can*, unprivileged, **prevent the Mac from sleeping** in the window around a scheduled task, or keep it awake so the in-process timer fires. That sidesteps the entire root/helper problem at the cost of the Mac not sleeping (battery/heat). See §5.

---

## 3. Clobbering risk & safe scheduling

### Is `pmset repeat` a single system-wide rule that apps overwrite?

**Yes.** As quoted in §1, there is exactly **one** repeating pair (one power-on + one power-off), system-wide, per-machine (stored in the shared `com.apple.PowerManagement.plist`). If OpenHorn runs `pmset repeat wake ...`, it **destroys** any repeat schedule the user set in **System Settings > (Energy/Battery) Schedule** or that another app set. `pmset repeat cancel` wipes the pair entirely. **Do not use `repeat` for app scheduling** — it is a shared singleton you'll trample.

### `schedule` (one-off) is safer but still shared

`schedule` events are additive (multiple can coexist) and each carries an `owner` label, so they are far less destructive than `repeat`. But they still live in the **same system-wide list**. `pmset schedule cancelall` would wipe **everyone's** one-off events, not just yours. So:

- **Never** call `pmset repeat ...` or `pmset schedule cancelall`.
- Tag every event you create with a distinctive `owner` (e.g. `"OpenHorn"`) so you can identify and cancel **only yours**.

### Safe pattern: read → append → cancel-only-ours

1. **Read** current schedule (no root needed): `pmset -g sched`. Parse the list; note existing events and their owners.
2. **Append** a new one-off wake for your next task time, tagged with your owner:
   `pmset schedule wake "MM/dd/yy HH:mm:ss" "OpenHorn"`
3. **Cancel only your own** event when the task is done / rescheduled, by re-specifying the exact type + time + owner:
   `pmset schedule cancel wake "MM/dd/yy HH:mm:ss" "OpenHorn"`
4. **Never** `cancelall` and **never** touch `repeat`. Leave every event whose owner is not yours untouched.
5. Because the ceiling on queued events is small, prune your own stale/past events so you don't fill the list.

> Note: `pmset -g sched` output format (parseable but not a stable machine format) lists lines like `wake at MM/dd/yy HH:mm:ss by <ownerpid/owner>`. Parse defensively.

---

## 4. Invoking pmset from Tauri's Rust side (`std::process::Command`)

The repo already shells out from Rust (`apps/desktop/src-tauri/src/lib.rs`). The exact command strings:

### Read the current schedule (no privilege)

```rust
use std::process::Command;

let out = Command::new("/usr/bin/pmset")
    .args(["-g", "sched"])
    .output()?;
let listing = String::from_utf8_lossy(&out.stdout);
```

### Schedule a one-off wake at a timestamp (REQUIRES ROOT)

Raw command (what the privileged helper / daemon runs as root):

```
/usr/bin/pmset schedule wake "09/05/26 07:00:00" "OpenHorn"
```

- Timestamp format is **`MM/dd/yy HH:mm:ss`**, 24-hour, **quoted**. Build it in Rust from the target `chrono`/`SystemTime`, formatted in the **local** timezone (pmset interprets it as local time).
- Direct (non-elevated) call — will FAIL unless the process is root:

```rust
Command::new("/usr/bin/pmset")
    .args(["schedule", "wake", "09/05/26 07:00:00", "OpenHorn"])
    .status()?; // Errors: not privileged, unless run as root
```

- Via one-shot admin prompt (Option A — prompts the user each time):

```rust
// osascript elevation; user sees the macOS auth dialog.
let script = r#"do shell script "/usr/bin/pmset schedule wake \"09/05/26 07:00:00\" \"OpenHorn\"" with administrator privileges"#;
Command::new("/usr/bin/osascript").args(["-e", script]).status()?;
```

  Escaping caution: the timestamp's inner quotes must be `\"`-escaped inside the AppleScript string. Build carefully; avoid string-injection by validating the timestamp with a strict regex before interpolating.

- Via privileged helper (Option B — no prompt after install): the Rust side sends an XPC/socket message to your root daemon; the **daemon** runs the `pmset schedule wake` line above. No `osascript`, no prompt.

### List scheduled events

```
/usr/bin/pmset -g sched
```

### Cancel one (only yours)

```
/usr/bin/pmset schedule cancel wake "09/05/26 07:00:00" "OpenHorn"
```

(Under Option A, wrap in the same `osascript ... with administrator privileges`; under Option B, the daemon runs it.)

> Always use absolute path `/usr/bin/pmset` (and `/usr/bin/osascript`, `/usr/bin/caffeinate`) rather than relying on `PATH`, especially from a daemon context.

---

## 5. After wake: the short window, and holding the Mac awake for the task

### Is there a brief window before it sleeps again?

**Yes.** As covered in §1, a scheduled wake (especially lid-closed / dark wake / on battery) gives you only a **short, bounded window** before the system returns to sleep. You must grab a power assertion **immediately** on wake to extend it for the task duration, then release it so the Mac can sleep again (important for battery/heat, and so your next `pmset schedule wake` is what wakes it).

### Option 1 — `caffeinate` (easy, no privilege)

`man caffeinate` (read locally):

- `caffeinate [-dismu] [-t timeout] [-w pid] [utility args...]` — creates I/O Kit power assertions.
- Flags:
  - `-i` prevent **idle** system sleep.
  - `-s` prevent system sleep — **"valid only when system is running on AC power."** (So `-s` does nothing useful on battery — a key limitation for the battery+lid-closed case.)
  - `-d` prevent display sleep, `-m` prevent disk idle sleep, `-u` declare user active (turns display on).
  - `-t <seconds>` hold the assertion for a timeout, then drop it.
  - `-w <pid>` hold until the given pid exits.
  - If a `utility` is given, the assertion lasts exactly for that utility's run: `caffeinate -i make`.

Patterns for OpenHorn:

```bash
# Hold "no idle sleep" for the duration of the task process, auto-released when it exits:
caffeinate -i -w <task_pid>

# Or wrap the whole run so the assertion is tied to the child's lifetime:
caffeinate -i /path/to/run-scheduled-task
```

From Rust:

```rust
// Spawn caffeinate tied to our own process (release on exit), no root needed:
let _caffeinate = Command::new("/usr/bin/caffeinate")
    .args(["-i", "-w", &std::process::id().to_string()])
    .spawn()?;
```

Limitation: `caffeinate` on **battery** can only prevent **idle** sleep (`-i`); it cannot force-hold sleep the way `-s` does on AC. Combined with the dark-wake behavior, that is why battery+lid-closed is best-effort.

### Option 2 — `IOPMAssertion` (programmatic, finer control, no privilege)

Directly create/release an assertion via the IOKit C API (`IOKit.framework`) — the same mechanism `caffeinate` uses, but in-process and precisely scoped:

- `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep, kIOPMAssertionLevelOn, CFSTR("OpenHorn scheduled task"), &assertionID)` on wake / task start.
- `IOPMAssertionRelease(assertionID)` when the task finishes → machine can sleep again.
- Assertion types: `kIOPMAssertionTypePreventUserIdleSystemSleep` (prevent idle system sleep — the right one for "I'm doing work"), `kIOPMAssertionTypePreventUserIdleDisplaySleep`, and the stronger `kIOPMAssertPreventSystemSleep` used for background/maintenance work. (WWDC 2012 "Power Management" session is the canonical reference; sixcolors 2026 "Keeping track of Mac sleep settings" confirms `PreventUserIdleSystemSleep` semantics.)
- Visible in `pmset -g assertions` while held — useful for debugging ("who's keeping the Mac awake").
- No privilege required. From Tauri Rust you'd bind IOKit via a crate (e.g. `io-kit-sys` / `core-foundation`) or FFI, or simply shell out to `caffeinate` (Option 1) to avoid the FFI.

### Recommended runtime sequence

1. Before sleep (or after each run), app/daemon computes next `nextRunAt` and calls `pmset schedule wake "<time>" "OpenHorn"` (root, via helper).
2. RTC fires at `nextRunAt` → Mac dark-wakes.
3. A **root LaunchDaemon** (the piece the OS reliably runs during wake) fires, **immediately** takes an `IOPMAssertion` / spawns `caffeinate -i`.
4. Daemon signals the sidecar/app (or runs the task directly) — task executes within the held-awake window.
5. On completion: **release** the assertion / let `caffeinate` exit, **schedule the next** one-off wake, and let the Mac return to sleep.

---

## Per-user permission cost — summary table

| Mechanism | One-time cost | Per-schedule-change cost | Ships in a downloadable app? |
|---|---|---|---|
| `pmset schedule wake` via `osascript ... with administrator privileges` | none | **admin password / Touch ID prompt EVERY time** | Technically yes, but bad UX; stop-gap only |
| `pmset` via **SMAppService** privileged LaunchDaemon (macOS 13+) | **one** approval at enable (System Settings) + app must be **Developer ID signed & notarized** | **none** (silent XPC) | **Yes — recommended** |
| `pmset` via legacy **SMJobBless** helper | one admin prompt at install + signed/notarized | none | Yes (deprecated API; use for < macOS 13) |
| `caffeinate` / `IOPMAssertion` (prevent sleep only, no waking) | **none** | **none** | Yes — but does NOT wake a sleeping Mac; only keeps it awake |
| `pmset repeat wake` | (root, same as above) | — | **Avoid** — single system-wide rule, clobbers user/other-app schedule |

---

## Caveats / Not found / confidence

- **Battery + lid-closed reliability is the real risk** and is hardware/OS-version dependent (Intel vs Apple Silicon, Power Nap, Low Power Mode). Confidence on exact awake duration: **medium**. Must be validated on target hardware (MacBook on battery, lid shut) — not just at a desk on AC.
- **Exact max count of queued `schedule` events**: not authoritatively documented in the man page; community reports a small ceiling. Treat as "a few," prune aggressively. **Not found (authoritative number).**
- **`osascript` auth caching duration**: historically ~5 min *within one process/authorization session*; not durable across separate app invocations. Confidence: **medium-high** (multiple corroborating threads, no single Apple doc pinning the exact TTL).
- **SMAppService entitlement/plist exact strings**: not reproduced here in full — this is a packaging exercise requiring Developer ID signing + notarization + `SMPrivilegedExecutables` / launchd `AssociatedBundleIdentifiers` + code-signing-requirement pinning. See `theevilbit.github.io/posts/smappservice/`, Apple `developer.apple.com/documentation/servicemanagement/smappservice`, and `trilemma-dev/SwiftAuthorizationSample` (SMJobBless reference).
- **StackExchange page extraction was blocked** by the search tool; specifics above are grounded in the local `man pmset` / `man caffeinate` (authoritative) plus search-result snippets (corroboration).
- Everything in §1 marked from `man pmset` (root requirement, one-repeat-pair, persistence plist, date format, event types, `relative` uncancelable) is **high confidence** — read directly from the man page on this machine.

## External references

- `man pmset`, `man caffeinate` (local, macOS) — authoritative.
- Apple Developer: SMAppService — https://developer.apple.com/documentation/servicemanagement/smappservice
- SMAppService walkthrough — https://theevilbit.github.io/posts/smappservice/
- Embedded daemons + XPC — https://dev.to/brysontyrrell/macos-apps-with-embedded-daemons-333a
- SMJobBless + XPC reference sample — https://github.com/trilemma-dev/SwiftAuthorizationSample
- DssW pmset reference — https://www.dssw.co.uk/reference/pmset/
- `do shell script ... with administrator privileges` re-prompts — https://www.macscripter.net/t/do-shell-script-with-administrator-privileges-still-asks-for-pass/73610
- PreventUserIdleSystemSleep semantics — https://sixcolors.com/post/2026/05/keeping-and-losing-track-of-mac-sleep-settings/ ; WWDC 2012 Power Management — https://nonstrict.eu/wwdcindex/wwdc2012/711/
- Clamshell-on-battery sleeps — https://www.reddit.com/r/MacOS/comments/1cd4v65/
