import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_ATTACHMENT_PATH_PREFIX, removeAttachmentFiles } from "./attachmentService";

// Deleting an attachment row used to leave its blob on disk forever: nothing in
// the codebase called unlink, and once the row was gone the path was
// unrecoverable. These guard the cleanup helper that closes that leak.
describe("removeAttachmentFiles", () => {
  test("deletes the blobs it is given", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-att-"));
    const a = path.join(dir, "a.png");
    const b = path.join(dir, "b.pdf");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    await removeAttachmentFiles([a, b]);

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  // Sidecar runs record `local:<name>`: the file lives on the user's machine and
  // was never uploaded, so there is nothing here to unlink.
  test("skips local: marker paths instead of treating them as real files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-att-"));
    const real = path.join(dir, "real.png");
    writeFileSync(real, "x");

    await removeAttachmentFiles([`${LOCAL_ATTACHMENT_PATH_PREFIX}notes.md`, real]);

    // The marker is ignored and the real neighbour is still removed.
    expect(existsSync(real)).toBe(false);
  });

  test("a missing file does not stop the remaining deletions", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-att-"));
    const gone = path.join(dir, "already-gone.png");
    const present = path.join(dir, "present.png");
    writeFileSync(present, "x");

    await removeAttachmentFiles([gone, present]);

    expect(existsSync(present)).toBe(false);
  });

  test("tolerates empty input and blank paths", async () => {
    await removeAttachmentFiles([]);
    await removeAttachmentFiles([""]);
    expect(true).toBe(true);
  });
});
