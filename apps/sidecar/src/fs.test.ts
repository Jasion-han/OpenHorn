import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsList, fsReadText, fsWriteText } from "./fs";
import { canonicalizeWorkspaceRoot } from "./workspace";

describe("fs", () => {
  test("lists entries and hides .openhorn", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, ".openhorn"));
    writeFileSync(path.join(root, "src", "a.txt"), "hi");

    const { entries } = await fsList({ workspaceRoot: root, dir: "." });
    expect(entries.some((e) => e.name === ".openhorn")).toBe(false);
    expect(entries.some((e) => e.name === "src" && e.kind === "dir")).toBe(true);
  });

  test("reads and writes text", async () => {
    const root = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-ws-")),
    );
    await fsWriteText({ workspaceRoot: root, filePath: "a.txt", content: "hello" });
    const { content } = await fsReadText({ workspaceRoot: root, filePath: "a.txt" });
    expect(content).toBe("hello");
  });

  test("fsWriteText refuses to write through a symlink that escapes the workspace", async () => {
    const baseTemp = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-attack-")),
    );
    const root = path.join(baseTemp, "ws");
    mkdirSync(root);
    const outside = path.join(baseTemp, "outside");
    mkdirSync(outside);
    const sensitiveTarget = path.join(outside, "secret.txt");
    writeFileSync(sensitiveTarget, "ORIGINAL_SECRET");

    // Plant a symlink inside the workspace pointing at an existing file
    // outside the workspace. fsWriteText must NOT clobber that file.
    symlinkSync(sensitiveTarget, path.join(root, "trap.txt"));

    let threw = false;
    try {
      await fsWriteText({
        workspaceRoot: root,
        filePath: "trap.txt",
        content: "PWNED",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(readFileSync(sensitiveTarget, "utf8")).toBe("ORIGINAL_SECRET");
  });

  test("fsWriteText refuses to create a new file through a symlink dir that escapes the workspace", async () => {
    const baseTemp = await canonicalizeWorkspaceRoot(
      mkdtempSync(path.join(os.tmpdir(), "openhorn-attack-")),
    );
    const root = path.join(baseTemp, "ws");
    mkdirSync(root);
    const outside = path.join(baseTemp, "outside");
    mkdirSync(outside);

    // workspace/escape -> outside dir; writing workspace/escape/new.txt would
    // create outside/new.txt unless we resolve the parent first.
    symlinkSync(outside, path.join(root, "escape"));

    let threw = false;
    try {
      await fsWriteText({
        workspaceRoot: root,
        filePath: "escape/new.txt",
        content: "PWNED",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });
});
