import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentWorkingDirectory } from "./agentWorkspace";

const README_CANDIDATES = ["README.md", "readme.md", "README", "readme"];
const MAX_CONTEXT_CHARS = 12_000;

export function buildCurrentWorkspaceSystemContext() {
  const workspaceRoot = resolveAgentWorkingDirectory();
  const readmePath = README_CANDIDATES.map((name) => join(workspaceRoot, name)).find((path) =>
    existsSync(path),
  );

  if (!readmePath) {
    return [
      "Current workspace question detected.",
      "Treat references to the current project, repository, codebase, or README as referring to the local workspace available to the agent.",
      "Prefer local files and local tools over websites or external product docs.",
      "Do not assume the user means Cursor docs, official websites, or any external page unless the user explicitly asks for web lookup.",
      "No workspace README file was found at the resolved workspace root. If needed, say that directly instead of inventing content.",
    ].join("\n");
  }

  const readmeContent = readFileSync(readmePath, "utf8").slice(0, MAX_CONTEXT_CHARS).trim();

  return [
    "Current workspace question detected.",
    "Treat references to the current project, repository, codebase, or README as referring to the local workspace available to the agent.",
    "Prefer local files and local tools over websites or external product docs.",
    "Do not assume the user means Cursor docs, official websites, or any external page unless the user explicitly asks for web lookup.",
    `Resolved workspace root: ${workspaceRoot}`,
    `Resolved README path: ${readmePath}`,
    "Local README content follows. Ground the answer in this file. If something is not stated here, say so plainly.",
    readmeContent,
  ].join("\n\n");
}
