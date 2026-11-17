import { expect, test } from "bun:test";
import {
  alignDocumentMetadata,
  DOCUMENT_LIMITS,
  type DocumentInputError,
  type DocumentRenderer,
  documentPageNumbers,
  expandDocumentFiles,
  hasMissingPdfInput,
} from "./documentInput";

test("document page selection retains actual numbers, expands ranges and deduplicates", () => {
  expect(documentPageNumbers("5, 1-3,2", 20)).toEqual([1, 2, 3, 5]);
  expect(documentPageNumbers("", 2)).toEqual([1, 2]);
});

test("a stopped Chat PDF with metadata only cannot be retried as if its original existed", () => {
  const attachmentsMeta = [{ fileName: "scanned.pdf", fileType: "application/pdf" }];
  expect(hasMissingPdfInput({ attachmentsMeta })).toBe(true);
  expect(hasMissingPdfInput({ attachmentsMeta, attachments: ["local:scanned.pdf"] })).toBe(true);
  expect(hasMissingPdfInput({ attachmentsMeta, attachments: ["persisted-original"] })).toBe(false);
  expect(hasMissingPdfInput({ attachmentsMeta: [{ fileName: "note.txt" }] })).toBe(false);
});
for (const value of [
  "",
  "0",
  "7",
  "1-7",
  "3-1",
  "1,,2",
  "1.5",
  "1-9999999999",
  "1,2,3,4,5,6,7",
  "Infinity",
])
  test(`invalid/over-limit PDF selection ${JSON.stringify(value)} is rejected`, () => {
    let code = "";
    try {
      documentPageNumbers(value, value === "" ? 20 : 6);
    } catch (error) {
      code = (error as DocumentInputError).code;
    }
    expect(code).toBe("document_pages");
  });

test("real generated page files preserve source names, selected page identity and actual image bytes", async () => {
  const pdf = new File(["synthetic-pdf"], "figures.pdf", { type: "application/pdf" });
  const rendered: number[] = [];
  let destroyed = 0;
  const files = await expandDocumentFiles(
    [pdf],
    () => ({ layout: true, pages: "2,4" }),
    true,
    new AbortController().signal,
    async () => ({
      pages: 20,
      render: async (page) => {
        rendered.push(page);
        return new Blob([new Uint8Array([255, 216, 255, page])], { type: "image/jpeg" });
      },
      destroy: async () => {
        destroyed++;
      },
    }),
  );
  expect(rendered).toEqual([2, 4]);
  expect(files.map((file) => file.name)).toEqual([
    "figures.pdf",
    "figures.pdf [page 2].jpg",
    "figures.pdf [page 4].jpg",
  ]);
  expect(new Uint8Array(await files[2].arrayBuffer())[3]).toBe(4);
  expect(destroyed).toBe(1);
});

test("text-only PDF mode never loads a renderer", async () => {
  const file = new File(["pdf"], "file.pdf");
  let opened = 0;
  const result = await expandDocumentFiles(
    [file],
    () => ({ layout: false, pages: "" }),
    false,
    new AbortController().signal,
    async () => {
      opened++;
      throw new Error("not expected");
    },
  );
  expect(result).toEqual([file]);
  expect(opened).toBe(0);
});

test("non-vision models cannot silently discard selected PDF images", async () => {
  let code = "";
  try {
    await expandDocumentFiles(
      [new File(["pdf"], "x.pdf")],
      () => ({ layout: true, pages: "1" }),
      false,
      new AbortController().signal,
    );
  } catch (error) {
    code = (error as DocumentInputError).code;
  }
  expect(code).toBe("document_vision");
});

test("a combined multi-document limit is enforced and every open document is destroyed", async () => {
  let destroyed = 0,
    rendered = 0;
  const renderer = async (): Promise<DocumentRenderer> => ({
    pages: 4,
    render: async () => {
      rendered++;
      return new Blob(["bytes"], { type: "image/jpeg" });
    },
    destroy: async () => {
      destroyed++;
    },
  });
  let code = "";
  try {
    await expandDocumentFiles(
      [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")],
      () => ({ layout: true, pages: "" }),
      true,
      new AbortController().signal,
      renderer,
    );
  } catch (error) {
    code = (error as DocumentInputError).code;
  }
  expect(code).toBe("document_pages");
  expect(rendered).toBe(4);
  expect(destroyed).toBe(2);
});

test("oversized page failure does not return partially generated documents", async () => {
  let destroyed = false,
    code = "";
  try {
    await expandDocumentFiles(
      [new File(["a"], "a.pdf")],
      () => ({ layout: true, pages: "" }),
      true,
      new AbortController().signal,
      async () => ({
        pages: 2,
        render: async () => new Blob([new Uint8Array(DOCUMENT_LIMITS.imageBytes + 1)]),
        destroy: async () => {
          destroyed = true;
        },
      }),
    );
  } catch (error) {
    code = (error as DocumentInputError).code;
  }
  expect(code).toBe("document_size");
  expect(destroyed).toBe(true);
});

test("Stop during page rendering destroys the document and prevents returning image files", async () => {
  const control = new AbortController();
  let destroyed = false,
    rejected = false;
  try {
    await expandDocumentFiles(
      [new File(["a"], "a.pdf")],
      () => ({ layout: true, pages: "1" }),
      true,
      control.signal,
      async () => ({
        pages: 1,
        render: async () => {
          control.abort();
          return new Blob(["bytes"]);
        },
        destroy: async () => {
          destroyed = true;
        },
      }),
    );
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(destroyed).toBe(true);
});

test("multiple PDFs keep derived images aligned with their own preview and upload identity", () => {
  const a = new File(["a"], "a.pdf"),
    b = new File(["b"], "b.pdf");
  const pageA = new File(["image-a"], "a.pdf [page 1].jpg"),
    pageB = new File(["image-b"], "b.pdf [page 1].jpg");
  const metadata = alignDocumentMetadata(
    [a, pageA, b, pageB],
    [a, b],
    [
      { fileName: "a.pdf", preview: "original-a" },
      { fileName: "b.pdf", preview: "original-b" },
    ],
    (file) => ({ fileName: file.name, preview: `generated-${file.name}` }),
  );
  expect(metadata.map((item) => item.preview)).toEqual([
    "original-a",
    "generated-a.pdf [page 1].jpg",
    "original-b",
    "generated-b.pdf [page 1].jpg",
  ]);
});
