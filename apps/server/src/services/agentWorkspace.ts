import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type ResolveAgentWorkingDirectoryOptions = {
  startDir?: string;
  maxAscendLevels?: number;
};

function scoreDirectory(dir: string) {
  let score = 0;
  if (existsSync(join(dir, ".git"))) score += 4;
  if (existsSync(join(dir, "package.json"))) score += 2;
  if (existsSync(join(dir, "README.md")) || existsSync(join(dir, "readme.md"))) score += 2;
  return score;
}

export function resolveAgentWorkingDirectory(
  options: ResolveAgentWorkingDirectoryOptions = {},
) {
  const startDir = resolve(options.startDir || process.cwd());
  const maxAscendLevels = options.maxAscendLevels ?? 6;

  let currentDir = startDir;
  let bestDir = startDir;
  let bestScore = scoreDirectory(startDir);

  for (let level = 0; level < maxAscendLevels; level += 1) {
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;

    currentDir = parentDir;
    const score = scoreDirectory(currentDir);
    if (score > bestScore) {
      bestDir = currentDir;
      bestScore = score;
    }
  }

  return bestDir;
}
