# Research: AI Agent CLI Skill (SKILL.md) Disk Locations for Local Discovery

- **Query**: Where do the major AI Agent CLIs install/store "Agent Skills" (SKILL.md folders) on the user's machine, for an OpenHorn desktop "scan installed skills and import" feature (mirroring its existing MCP config discovery).
- **Scope**: mixed (external official docs + live inspection of this machine)
- **Date**: 2026-06-30

## TL;DR

- A **skill = a directory containing a `SKILL.md` file** (YAML frontmatter `name` + `description`, then markdown body). This is the cross-tool "Agent Skills" open standard (agentskills.io). Optional `scripts/`, `references/`, `assets/`, `.claude-plugin/plugin.json`, `agents/openai.yaml`.
- **Claude Code, Codex CLI, and Gemini CLI all officially support SKILL.md skills** and largely share the format. The directory locations differ per tool.
- **`~/.agents/skills/` is the emerging cross-tool interoperable path**: it is an official USER-level location for both Codex CLI and Gemini CLI (Gemini also treats `.agents/skills/` as a workspace alias). Worth scanning even though it does not exist on this machine yet.
- **Cursor does NOT use SKILL.md** — it uses `.cursor/rules/*.mdc`. No skill concept. Do not invent a Cursor skill source.
- On THIS machine, a third-party multi-CLI manager **cc-switch** is the real source of truth: it stores skills in `~/.cc-switch/skills/<name>/SKILL.md` and **symlinks** them into `~/.codex/skills/` and `~/.gemini/skills/`. OpenHorn's existing MCP discovery already special-cases cc-switch (reads `~/.cc-switch/cc-switch.db`), so skill discovery should treat cc-switch as a first-class, deduped source too.

## Findings

### 1. Claude Code (official) — confirmed

Source: https://code.claude.com/docs/en/skills (extracted 2026-06-30)

Precedence table (from docs): enterprise > personal > project; plugin skills are namespaced separately.

| Level | Path pattern | Scope |
|---|---|---|
| Personal (global) | `~/.claude/skills/<name>/SKILL.md` | All projects |
| Project | `<project>/.claude/skills/<name>/SKILL.md` | This project (also parent dirs up to repo root, and nested `*/.claude/skills/` on demand) |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where plugin enabled; namespaced `plugin-name:skill-name` |

Plugin skills on disk (confirmed live on this machine) live under the plugin cache:
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`
  e.g. `~/.claude/plugins/cache/openai-codex/codex/1.0.4/skills/codex-cli-runtime/SKILL.md`
- Also present (git checkouts of marketplaces): `~/.claude/plugins/marketplaces/<marketplace>/.../skills/<name>/SKILL.md`
- Installed plugin → installPath mapping is in `~/.claude/plugins/installed_plugins.json` (authoritative for which cache dirs are active; prefer it over globbing all cache versions to avoid importing stale/duplicate versions like codex `1.0.3` and `1.0.4`).

Notes:
- `.claude/commands/*.md` (single-file commands) are now merged into the skills system but are NOT SKILL.md folders — likely out of scope for a "SKILL.md import" feature.
- Live change detection: Claude watches these dirs. Not relevant to a one-shot scan.

SKILL.md frontmatter (Claude):
```yaml
---
name: my-skill                # directory/command name
description: When to use this skill...   # drives auto-invocation
# optional: allowed-tools, model, etc. (see frontmatter reference)
---
# markdown body = instructions
```

### 2. Codex CLI (OpenAI) — official, has skills

Source: https://developers.openai.com/codex/skills (extracted 2026-06-30) + community threads.

Official discovery locations (current docs) — REPO / USER / ADMIN / SYSTEM:

| Tier | Path pattern |
|---|---|
| REPO | `$CWD/.agents/skills`, each parent dir up to repo root, `$REPO_ROOT/.agents/skills` |
| USER | `~/.agents/skills/` |
| ADMIN / SYSTEM | platform-managed (not detailed in public doc) |

Important historical/experimental nuance:
- Earlier experimental Codex builds discovered user skills from **`~/.codex/skills/**/SKILL.md`** (only files named exactly `SKILL.md`). Many third-party guides and tools (incl. cc-switch) still install there.
- Codex also ships bundled "system" skills in **`~/.codex/skills/.system/`** (live on this machine: `imagegen`, `openai-docs`, `plugin-creator`, `skill-creator`, `skill-installer`). These are first-party defaults — probably should be excluded or labeled, not imported as user skills.
- Disable (not delete) a skill via `[[skills.config]]` entries with `path = ".../SKILL.md"` in `~/.codex/config.toml`. A scanner could read this to skip disabled skills.

Codex SKILL.md frontmatter requires `name` and `description`; may have a sibling `agents/openai.yaml`.

Practical recommendation for the scanner: scan BOTH `~/.agents/skills/` (current official user path) AND `~/.codex/skills/` (experimental + what cc-switch populates), excluding the `.system/` subdir.

### 3. Gemini CLI (Google) — official, has skills (v0.26.0+)

Source: https://geminicli.com/docs/cli/skills/ (extracted 2026-06-30). Based on the agentskills.io open standard.

Discovery tiers (low → high precedence):
1. Built-in skills (bundled with Gemini CLI)
2. (extension-provided)
3. **User skills**: `~/.gemini/skills/` OR the `~/.agents/skills/` alias
4. **Workspace skills**: `<project>/.gemini/skills/` OR the `<project>/.agents/skills/` alias

Within a tier, the `.agents/skills/` alias takes precedence over `.gemini/skills/`.

Management: `gemini skills list/install/uninstall`, `/skills link <path> --scope user|workspace`, `/skills disable|enable`. Same SKILL.md (name + description frontmatter) format.

Caveat from the doc banner: Google announced Gemini CLI is being transitioned to "Antigravity CLI" for some tiers — path conventions may shift in future versions, but `~/.gemini/skills/` + `~/.agents/skills/` are current.

### 4. Cursor / others — no SKILL.md skill concept

- **Cursor**: uses project rules `<project>/.cursor/rules/*.mdc` and `.cursorrules`; MCP at `~/.cursor/mcp.json`. No SKILL.md skills directory. **Do not fabricate a Cursor skill source.**
- **OpenCode**: config-based (`~/.config/opencode/opencode.json`); no SKILL.md skill folder convention found.
- **Claude Desktop app**: MCP only (`claude_desktop_config.json`), no skills.

### 5. Live machine inventory (real paths that actually have skills)

Verified via `find ... -name SKILL.md` on 2026-06-30:

- `~/.claude/skills/<name>/SKILL.md` — present (e.g. `loops-email-template`). NOTE: most other entries listed by the tool are symlinks/managed; only real SKILL.md dirs count.
- `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/skills/<name>/SKILL.md` — present (codex, claude-mem, etc.)
- `~/.claude/plugins/marketplaces/<mp>/.../skills/<name>/SKILL.md` — present
- `<repo>/.claude/skills/<name>/SKILL.md` — present in OpenHorn itself (`trellis-*`) and `<repo>/skills/openhorn/SKILL.md`
- `~/.codex/skills/<name>/SKILL.md` — present; **most entries are symlinks → `~/.cc-switch/skills/<name>`**; some are real dirs (e.g. `pdf`, `xlsx`, `codex-primary-runtime`, `boss`).
- `~/.codex/skills/.system/<name>/SKILL.md` — present (Codex bundled defaults).
- `~/.gemini/skills/<name>/SKILL.md` — present; same symlink-to-cc-switch pattern.
- `~/.cc-switch/skills/<name>/SKILL.md` — **the central real store** (~30+ skills) that the codex/gemini dirs symlink to.
- `~/.agents/skills` — **does NOT exist yet** on this machine (but is the official cross-tool path; scan it anyway, skip if missing).

cc-switch detail: `~/.cc-switch/settings.json` has `skillStorageLocation: "cc_switch"`, `skillSyncMethod: "auto"`, `enableClaudePluginIntegration: true`, and `visibleApps` for claude/codex/gemini. It syncs one skill set across CLIs via symlinks. Because of this, a naive scan of all CLI dirs will see the SAME skill many times → **dedup is essential** (resolve symlinks / dedup by realpath or by `name`).

### Code Patterns — OpenHorn's existing MCP discovery (the model to mirror)

`apps/desktop/src/lib/tauriBridge.ts:46` — `discoverMcpConfigs()` calls Tauri command `mcp_discover_configs`; returns `DiscoveredMcpServer[]` with a `clients` array listing every platform a tool was found in.

`apps/desktop/src-tauri/src/lib.rs:541` — `fn mcp_discover_configs(app)` is the reference implementation of the exact "scan known paths → parse → dedup" pattern requested:
- Reads `home_dir()` / `config_dir()`.
- **cc-switch first** as "global source of truth" (`read_ccswitch_db(~/.cc-switch/cc-switch.db)`, lib.rs:548-550) — wins dedup, carries descriptions.
- Then per-client files: Claude Code (`~/.claude.json`, `~/.claude/.mcp.json`), Codex (`~/.codex/config.toml`), Gemini (`~/.gemini/settings.json`), Cursor (`~/.cursor/mcp.json`), OpenCode, Claude Desktop.
- **Dedup by signature** accumulating a `clients: Vec<String>` list (lib.rs:593-611). Missing/unreadable sources skipped silently.
- Registered in the Tauri invoke handler (lib.rs:721); companion `mcp_pick_config_file` (lib.rs:619) lets the user import from a file picker.

A skill scanner should follow the same shape: a new Tauri command (e.g. `skills_discover`) that walks the skill dirs below, reads each `SKILL.md` frontmatter (`name`, `description`), resolves symlinks, dedups by `name`/realpath, and returns `{ name, description, path, sources: [...] }`.

## Conclusion — real skill source paths worth scanning

Absolute patterns (expand `~` = `$HOME`). Each `<name>` dir must contain a `SKILL.md`.

| Platform | Path pattern | Format | Notes |
|---|---|---|---|
| Claude Code (personal) | `~/.claude/skills/<name>/SKILL.md` | SKILL.md | Official |
| Claude Code (project) | `<project>/.claude/skills/<name>/SKILL.md` | SKILL.md | Plus parent dirs to repo root |
| Claude Code (plugins) | `~/.claude/plugins/cache/<mp>/<plugin>/<ver>/skills/<name>/SKILL.md` | SKILL.md | Use `~/.claude/plugins/installed_plugins.json` to pick active versions |
| Codex CLI (user, current) | `~/.agents/skills/<name>/SKILL.md` | SKILL.md | Official cross-tool path; may be absent |
| Codex CLI (user, legacy/cc-switch) | `~/.codex/skills/<name>/SKILL.md` | SKILL.md | Exclude `.system/`; resolve symlinks; honor `[[skills.config]]` disables in `~/.codex/config.toml` |
| Codex CLI (repo) | `<project>/.agents/skills/<name>/SKILL.md` | SKILL.md | Plus parent dirs |
| Gemini CLI (user) | `~/.gemini/skills/<name>/SKILL.md` and `~/.agents/skills/<name>/SKILL.md` | SKILL.md | Official |
| Gemini CLI (workspace) | `<project>/.gemini/skills/<name>/SKILL.md` and `<project>/.agents/skills/<name>/SKILL.md` | SKILL.md | Official |
| cc-switch central store | `~/.cc-switch/skills/<name>/SKILL.md` | SKILL.md | Real source of truth on this machine; symlinked into codex/gemini dirs — dedup! |

Explicitly **NO skill concept (do not fabricate a source)**:
- **Cursor** → `.cursor/rules/*.mdc` only, not SKILL.md.
- **OpenCode**, **Claude Desktop** → config/MCP only, no SKILL.md skills.

## Caveats / Not Found

- `~/.agents/skills` and project-level `.agents/skills` were not present on this machine; their existence is asserted from official Codex + Gemini docs, not local verification.
- Codex ADMIN/SYSTEM skill locations are mentioned in the official doc but the exact OS paths are not published; only `~/.codex/skills/.system/` (bundled defaults) was observed locally.
- The Codex `~/.codex/skills/` path is described by community sources as experimental; future Codex versions may consolidate entirely on `~/.agents/skills/`. Scan both for robustness.
- Heavy symlink overlap (cc-switch) means the same skill appears under Claude? No — cc-switch here only feeds `~/.codex/skills` and `~/.gemini/skills`, not `~/.claude/skills`. Still, dedup by resolved realpath + `name` is mandatory to avoid 2-3x duplicates.
- Gemini CLI may be renamed/migrated to "Antigravity CLI"; revisit paths if targeting future versions.
