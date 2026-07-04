import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSkillsPromptSection, resolveSkills } from "./skills";

function tmpWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "openhorn-skills-"));
}

// Write a real skill dir on disk (as it lives in ~/.claude/skills etc.) so
// resolveSkills can read it in place.
function writeSkillDir(skillDir: string, skillMd: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), skillMd, "utf8");
}

describe("resolveSkills", () => {
  test("resolves in-place skill folders into prompt metadata", async () => {
    const skillDir = path.join(tmpWorkspace(), "pdf-tool");
    writeSkillDir(skillDir, "---\nname: PDF Tool\n---\n\n# PDF\nSteps");

    const materialized = await resolveSkills([
      { name: "PDF Tool", description: "Handle PDFs.  Use when the user\nmentions PDFs.", path: skillDir },
    ]);

    expect(materialized.length).toBe(1);
    expect(materialized[0].name).toBe("PDF Tool");
    // Description is collapsed onto one line.
    expect(materialized[0].description).toBe("Handle PDFs. Use when the user mentions PDFs.");
    expect(materialized[0].skillMdPath).toBe(path.join(skillDir, "SKILL.md"));
    expect(materialized[0].skillDir).toBe(skillDir);
  });

  test("skips a skill whose SKILL.md is missing (never throws)", async () => {
    const goodDir = path.join(tmpWorkspace(), "good");
    writeSkillDir(goodDir, "---\nname: good\n---\n\nbody");

    const materialized = await resolveSkills([
      { name: "missing", description: "d", path: "/tmp/does-not-exist-openhorn" },
      { name: "good", description: "d", path: goodDir },
    ]);
    expect(materialized.map((s) => s.name)).toEqual(["good"]);
  });

  test("returns [] when metas are absent", async () => {
    expect(await resolveSkills(undefined)).toEqual([]);
    expect(await resolveSkills([])).toEqual([]);
  });
});

describe("buildSkillsPromptSection", () => {
  test("references the SKILL.md path and the runtime's actual read tool", () => {
    const materialized = [
      {
        name: "PDF Tool",
        description: "Handle PDFs.",
        skillMdPath: "/ws/.openhorn/skills/pdf-tool/SKILL.md",
        skillDir: "/ws/.openhorn/skills/pdf-tool",
      },
    ];

    const claudeSection = buildSkillsPromptSection(materialized, "Read");
    expect(claudeSection?.includes("SKILL.md:")).toBe(true);
    expect(claudeSection?.includes("PDF Tool")).toBe(true);
    expect(claudeSection?.includes("`Read`")).toBe(true);
    expect(claudeSection?.includes("Folder:")).toBe(true);

    const directSection = buildSkillsPromptSection(materialized, "read_file");
    expect(directSection?.includes("`read_file`")).toBe(true);
  });

  test("returns undefined when empty", () => {
    expect(buildSkillsPromptSection([], "Read")).toBe(undefined);
  });
});
