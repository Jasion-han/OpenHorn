import { describe, expect, test } from "bun:test";
import type { AttachmentPart } from "shared/types";
import {
  appendAttachmentContext,
  buildFileContext,
  getImageAttachments,
  imageFallbackText,
  imageUnsupportedFormatText,
  isVisionSupportedImageType,
  MAX_FILE_TEXT_CHARS,
  normalizeImageMediaType,
  partitionImagesByFormat,
} from "./attachments";

describe("buildFileContext", () => {
  test("returns empty string when there are no attachments", () => {
    expect(buildFileContext()).toBe("");
    expect(buildFileContext([])).toBe("");
  });

  test("injects file text verbatim with a labeled header", () => {
    const parts: AttachmentPart[] = [
      { kind: "file", fileName: "notes.md", mediaType: "text/markdown", text: "hello world" },
    ];
    const ctx = buildFileContext(parts);
    expect(ctx).toBe("\n\n[附件文件] notes.md:\nhello world");
  });

  test("truncates oversized file text", () => {
    const big = "a".repeat(MAX_FILE_TEXT_CHARS + 500);
    const parts: AttachmentPart[] = [
      { kind: "file", fileName: "big.txt", mediaType: "text/plain", text: big },
    ];
    const ctx = buildFileContext(parts);
    expect(ctx.includes("[内容过长，已截断]")).toBe(true);
    expect(ctx.includes("a".repeat(MAX_FILE_TEXT_CHARS))).toBe(true);
  });

  test("ignores image attachments (no bytes leak into file context)", () => {
    const parts: AttachmentPart[] = [
      { kind: "image", mediaType: "image/png", dataBase64: "AAAA", fileName: "shot.png" },
    ];
    expect(buildFileContext(parts)).toBe("");
  });

  test("concatenates multiple file attachments in order, skipping images", () => {
    const parts: AttachmentPart[] = [
      { kind: "file", fileName: "a.txt", mediaType: "text/plain", text: "AAA" },
      { kind: "image", mediaType: "image/png", dataBase64: "x", fileName: "b.png" },
      { kind: "file", fileName: "c.txt", mediaType: "text/plain", text: "CCC" },
    ];
    const ctx = buildFileContext(parts);
    expect(ctx).toBe("\n\n[附件文件] a.txt:\nAAA\n\n[附件文件] c.txt:\nCCC");
  });
});

describe("getImageAttachments", () => {
  test("returns empty array when there are no attachments", () => {
    expect(getImageAttachments()).toEqual([]);
    expect(getImageAttachments([])).toEqual([]);
  });

  test("extracts only image parts, preserving order and bytes", () => {
    const parts: AttachmentPart[] = [
      { kind: "file", fileName: "a.txt", mediaType: "text/plain", text: "AAA" },
      { kind: "image", mediaType: "image/png", dataBase64: "AAAA", fileName: "b.png" },
      { kind: "image", mediaType: "image/jpeg", dataBase64: "BBBB" },
    ];
    expect(getImageAttachments(parts)).toEqual([
      { mediaType: "image/png", dataBase64: "AAAA", fileName: "b.png" },
      { mediaType: "image/jpeg", dataBase64: "BBBB", fileName: undefined },
    ]);
  });
});

describe("vision image format guard", () => {
  test("normalizes image/jpg to image/jpeg and lowercases", () => {
    expect(normalizeImageMediaType("image/jpg")).toBe("image/jpeg");
    expect(normalizeImageMediaType("IMAGE/PNG")).toBe("image/png");
    expect(normalizeImageMediaType(" image/webp ")).toBe("image/webp");
  });

  test("accepts only provider-supported formats", () => {
    expect(isVisionSupportedImageType("image/png")).toBe(true);
    expect(isVisionSupportedImageType("image/jpeg")).toBe(true);
    expect(isVisionSupportedImageType("image/jpg")).toBe(true);
    expect(isVisionSupportedImageType("image/gif")).toBe(true);
    expect(isVisionSupportedImageType("image/webp")).toBe(true);
    expect(isVisionSupportedImageType("image/bmp")).toBe(false);
    expect(isVisionSupportedImageType("image/svg+xml")).toBe(false);
    expect(isVisionSupportedImageType("image/heic")).toBe(false);
    expect(isVisionSupportedImageType("")).toBe(false);
  });

  test("partitions images and normalizes injectable media types", () => {
    const { injectable, unsupported } = partitionImagesByFormat([
      { mediaType: "image/jpg", dataBase64: "AAAA", fileName: "a.jpg" },
      { mediaType: "image/png", dataBase64: "BBBB", fileName: "b.png" },
      { mediaType: "image/bmp", dataBase64: "CCCC", fileName: "c.bmp" },
    ]);
    expect(injectable).toEqual([
      { mediaType: "image/jpeg", dataBase64: "AAAA", fileName: "a.jpg" },
      { mediaType: "image/png", dataBase64: "BBBB", fileName: "b.png" },
    ]);
    expect(unsupported).toEqual([
      { mediaType: "image/bmp", dataBase64: "CCCC", fileName: "c.bmp" },
    ]);
  });
});

describe("imageUnsupportedFormatText", () => {
  test("returns empty string when there are no images", () => {
    expect(imageUnsupportedFormatText([])).toBe("");
  });

  test("names the unsupported format and drops the bytes", () => {
    const text = imageUnsupportedFormatText([
      { mediaType: "image/bmp", dataBase64: "CCCC", fileName: "c.bmp" },
    ]);
    expect(text.includes("c.bmp")).toBe(true);
    expect(text.includes("image/bmp")).toBe(true);
    expect(text.includes("不受支持")).toBe(true);
    expect(text.includes("CCCC")).toBe(false);
  });
});

describe("imageFallbackText", () => {
  test("returns empty string when there are no images", () => {
    expect(imageFallbackText([])).toBe("");
  });

  test("emits a no-vision placeholder per image without leaking bytes", () => {
    const text = imageFallbackText([
      { mediaType: "image/png", dataBase64: "AAAA", fileName: "shot.png" },
    ]);
    expect(text.includes("shot.png")).toBe(true);
    expect(text.includes("当前模型不支持视觉")).toBe(true);
    expect(text.includes("AAAA")).toBe(false);
  });

  test("falls back to 'image' when an image has no file name", () => {
    const text = imageFallbackText([{ mediaType: "image/jpeg", dataBase64: "BBBB" }]);
    expect(text.includes("image]")).toBe(true);
  });
});

describe("appendAttachmentContext", () => {
  test("returns the prompt unchanged when there are no attachments", () => {
    expect(appendAttachmentContext("base prompt")).toBe("base prompt");
    expect(appendAttachmentContext("base prompt", [])).toBe("base prompt");
  });

  test("appends file context to the prompt", () => {
    const parts: AttachmentPart[] = [
      { kind: "file", fileName: "a.txt", mediaType: "text/plain", text: "hi" },
    ];
    expect(appendAttachmentContext("question", parts)).toBe("question\n\n[附件文件] a.txt:\nhi");
  });

  test("appends image fallback text by default", () => {
    const parts: AttachmentPart[] = [
      { kind: "image", mediaType: "image/png", dataBase64: "AAAA", fileName: "b.png" },
    ];
    const result = appendAttachmentContext("q", parts);
    expect(result.includes("当前模型不支持视觉")).toBe(true);
  });

  test("omits image fallback text when includeImageFallback is false", () => {
    const parts: AttachmentPart[] = [
      { kind: "image", mediaType: "image/png", dataBase64: "AAAA", fileName: "b.png" },
    ];
    const result = appendAttachmentContext("q", parts, { includeImageFallback: false });
    expect(result).toBe("q");
  });
});
