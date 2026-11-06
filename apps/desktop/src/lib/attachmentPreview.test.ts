import { describe, expect, test } from "bun:test";
import {
  attachmentKind,
  canOpenAttachment,
  loadAttachmentBlob,
  previewMediaType,
  readPreviewText,
} from "./attachmentPreview";

describe("attachment originals", () => {
  test("classifies generic MIME by extension and keeps active documents inert", () => {
    expect(attachmentKind({ fileName: "notes.TXT" })).toBe("text");
    expect(attachmentKind({ fileName: "slides.pdf", fileType: "application/octet-stream" })).toBe(
      "pdf",
    );
    expect(attachmentKind({ fileName: "README.md" })).toBe("markdown");
    expect(attachmentKind({ fileName: "page.html", fileType: "text/html" })).toBe("text");
    expect(attachmentKind({ fileName: "icon.svg", fileType: "image/svg+xml" })).toBe("image");
    expect(attachmentKind({ fileName: "data.zip" })).toBe("file");
    expect(attachmentKind({ fileName: "clip.mp4" })).toBe("video");
  });
  test("reads original local bytes and handles empty/truncated UTF8 text", async () => {
    const file = new File(["首行\n原文\n末行"], "notes.txt");
    expect(await (await loadAttachmentBlob({ fileName: file.name }, file)).text()).toBe(
      await file.text(),
    );
    expect(await readPreviewText(new Blob([]))).toEqual({ text: "", truncated: false });
    expect(await readPreviewText(new Blob(["abc中文def"]), 7)).toEqual({
      text: "abc中",
      truncated: true,
    });
  });
  test("missing sources produce a typed unavailable state", async () => {
    try {
      await loadAttachmentBlob({ fileName: "old.txt" });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).toBe("unavailable");
    }
  });
});

test("authenticated original-file requests distinguish missing, auth and network failures", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const [status, expected] of [
      [404, "unavailable"],
      [401, "auth"],
      [403, "auth"],
      [500, "network"],
    ] as const) {
      globalThis.fetch = (async (_input, init) => {
        expect(init?.credentials).toBe("include");
        return new Response("error", { status });
      }) as typeof fetch;
      try {
        await loadAttachmentBlob({ id: "saved", fileName: "test.txt" });
        throw new Error("expected failure");
      } catch (error) {
        expect((error as Error).message).toBe(expected);
      }
    }
    globalThis.fetch = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    try {
      await loadAttachmentBlob({ id: "saved", fileName: "test.txt" });
    } catch (error) {
      expect((error as Error).message).toBe("network");
    }
    globalThis.fetch = (async () => new Response("original")) as typeof fetch;
    expect(await (await loadAttachmentBlob({ id: "saved", fileName: "test.txt" })).text()).toBe(
      "original",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("missing media MIME is inferred without changing original bytes", () => {
  expect(previewMediaType({ fileName: "icon.svg" }, "")).toBe("image/svg+xml");
  expect(previewMediaType({ fileName: "clip.mp4" }, "application/octet-stream")).toBe("video/mp4");
});

test("revoked session URLs fall back to the authenticated uploaded original", async () => {
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = (async (input, init) => {
      requested.push(String(input));
      expect(init?.credentials).toBe("include");
      if (String(input).startsWith("blob:")) throw new TypeError("revoked");
      return new Response("original upload");
    }) as typeof fetch;
    const blob = await loadAttachmentBlob({
      fileName: "saved.txt",
      previewUrl: "blob:expired",
      id: "saved",
    });
    expect(await blob.text()).toBe("original upload");
    expect(requested.length).toBe(2);
    expect(requested[1].endsWith("/attachments/saved")).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("UTF16 BOM text retains Chinese characters in both byte orders", async () => {
  const text = "首行\noriginal 中文\n末行";
  for (const littleEndian of [true, false]) {
    const bytes = new Uint8Array(2 + text.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, littleEndian);
    for (let index = 0; index < text.length; index++)
      view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
    expect(await readPreviewText(new Blob([bytes]))).toEqual({ text, truncated: false });
  }
});

test("camera and scanned image formats retain their system-viewer fallback", () => {
  for (const fileName of ["photo.HEIC", "photo.heif", "scan.tif", "scan.tiff"]) {
    expect(attachmentKind({ fileName })).toBe("image");
    expect(canOpenAttachment(fileName)).toBe(true);
  }
  expect(previewMediaType({ fileName: "scan.tiff" }, "")).toBe("image/tiff");
  expect(previewMediaType({ fileName: "photo.heic" }, "")).toBe("image/heic");
});
