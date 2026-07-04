import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Agent Skills resolution + progressive-disclosure prompt.
 *
 * Skill content is materialized to disk ONCE by the desktop side (Rust
 * `skills_materialize_*` commands), into `<cwd>/.openhorn/skills/<name>/SKILL.md`
 * (+ bundled files) — the OpenHorn-owned `.openhorn/` directory (already
 * git-ignored, same as checkpoints). The agent.run message then carries only
 * lightweight metadata (name + description) plus the materialized `skillsRoot`,
 * so a run never ships skill bodies (which can be tens of MB) over the
 * WebSocket. This sidecar module just verifies the on-disk layout and turns it
 * into prompt metadata.
 *
 * The model is told about each skill's name/description and the SKILL.md path via
 * the system prompt (Level 1). It then reads the full SKILL.md and any bundled
 * resources on demand with its normal Read/Bash tools (Levels 2–3) — true
 * progressive disclosure, identical for the Claude SDK and direct runtimes.
 */

export type SkillMeta = {
  name: string;
  description?: string;
  /** Absolute path of the skill's real folder (read in place, Claude-style). */
  path: string;
};

export type MaterializedSkill = {
  name: string;
  description: string;
  skillMdPath: string;
  skillDir: string;
};

// Folder-safe skill name: lowercase, [a-z0-9-] only, matching Anthropic's
// frontmatter `name` rules. Falls back to "skill" if nothing survives. Must
// stay in sync with the desktop materializer's sanitization so the directory
// chosen on write matches the one resolved here on read.
export function sanitizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "skill";
}

// The description is the model's trigger AND a single YAML frontmatter value, so
// it must stay on one line — collapse any newlines/whitespace the user pasted in.
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/**
 * Resolve the already-materialized skills under `skillsRoot` into prompt
 * metadata. The desktop side wrote the content to disk; we only verify that
 * each skill's SKILL.md exists and surface its path. A skill whose SKILL.md is
 * missing is skipped (never throws) so one bad entry can't break the run.
 */
export async function resolveSkills(
  metas: SkillMeta[] | undefined,
): Promise<MaterializedSkill[]> {
  if (!metas || metas.length === 0) return [];

  const materialized: MaterializedSkill[] = [];
  for (const meta of metas) {
    if (!meta.path) continue;
    const skillDir = meta.path;
    const skillMdPath = path.join(skillDir, "SKILL.md");
    try {
      const info = await stat(skillMdPath);
      if (!info.isFile()) continue;
    } catch {
      continue; // folder missing / no SKILL.md — skip, don't fail the run
    }
    materialized.push({
      name: meta.name,
      description: normalizeDescription(meta.description ?? ""),
      skillMdPath,
      skillDir,
    });
  }

  return materialized;
}

/**
 * Build the Level-1 skills block injected into the system prompt.
 *
 * This is the ONLY thing about a skill that is always in context: each skill's
 * name + one-line description + the path to its full SKILL.md. The model decides
 * whether a skill applies purely from its description (the description IS the
 * trigger), then opens the SKILL.md on demand to load the real instructions
 * (Level 2) and any bundled resources it references (Level 3). This mirrors how
 * Claude Code / Codex skills work, but stays model-agnostic by naming the
 * runtime's actual file-reading tool rather than assuming a fixed tool name.
 *
 * @param readTool The exact name of this runtime's file-reading tool — `Read`
 *   for the Claude Agent SDK, `read_file` for the direct (OpenAI/generic)
 *   runtime. Using the wrong name makes non-Anthropic models call a tool that
 *   does not exist.
 */
export function buildSkillsPromptSection(
  materialized: MaterializedSkill[],
  readTool: string,
): string | undefined {
  if (materialized.length === 0) return undefined;

  const lines = [
    "# Skills",
    "You have a library of SKILLS — specialized, battle-tested playbooks for specific kinds of work. Each skill is summarized below by its name and a description of what it does and when to use it. The full step-by-step instructions live in a separate SKILL.md file that you open only when the skill is actually needed, so your context stays lean.",
    "",
    "How to use skills:",
    "- Treat each skill's description as its trigger. Before starting a task, check it against the skills below; a skill applies whenever the request falls within what its description covers.",
    `- When a skill applies, FIRST open its SKILL.md with the \`${readTool}\` tool and read it in full, THEN do the task by following those instructions. For that task they are authoritative — they take precedence over your default approach.`,
    "- A SKILL.md may reference other files (templates, references, scripts). Those live in the same folder as the SKILL.md (see each skill's Folder path below). Open or run them with your file and shell tools only when its instructions tell you to — don't read them eagerly.",
    "- If more than one skill could apply, pick the most specific. If none apply, just proceed normally.",
    "- Never announce, mention, or explain that you are using a skill, and don't ask permission to load one — silently read it and do the work.",
    "",
    "Available skills:",
  ];
  for (const skill of materialized) {
    lines.push(`- ${skill.name} — ${skill.description || "(no description provided)"}`);
    lines.push(`  SKILL.md: ${skill.skillMdPath}`);
    lines.push(`  Folder: ${skill.skillDir}`);
  }
  return lines.join("\n");
}
