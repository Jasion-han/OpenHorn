import { expect, test } from "bun:test";
import { uploadAttachments } from "./attachments";
import { DocumentInputError } from "./documentInput";

test("upload accepts server MIME resolution for untyped PDFs and legacy image aliases", async () => {
  const previous = globalThis.fetch;
  const files = [
    new File(["pdf"], "source.pdf", { type: "application/octet-stream" }),
    new File(["jpeg"], "page.jpg", { type: "image/jpg" }),
  ];
  globalThis.fetch = (async () =>
    Response.json({
      attachments: files.map((file, index) => ({
        id: String(index),
        fileName: file.name,
        fileSize: file.size,
        fileType: index === 0 ? "application/pdf" : "image/jpeg",
      })),
    })) as unknown as typeof fetch;
  try {
    expect(
      (await uploadAttachments({ conversationId: "synthetic", files })).attachments,
    ).toHaveLength(2);
  } finally {
    globalThis.fetch = previous;
  }
});

for (const problem of [
  "missing",
  "wrong-name",
  "wrong-size",
  "wrong-type",
  "empty-type",
  "invalid-json",
  "duplicate-id",
])
  test(`upload refuses ${problem} instead of sending an incomplete PDF/page context`, async () => {
    const previous = globalThis.fetch;
    const files = [
      new File(["pdf"], "source.pdf", { type: "application/pdf" }),
      new File(["jpeg"], "source.pdf [page 1].jpg", { type: "image/jpeg" }),
    ];
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect((init?.body as FormData).getAll("files")).toHaveLength(2);
      if (problem === "invalid-json") return new Response("{", { status: 201 });
      const rows = files.map((file, index) => ({
        id: String(index),
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      }));
      if (problem === "missing") rows.pop();
      if (problem === "wrong-name") rows[0].fileName = "different.pdf";
      if (problem === "wrong-size") rows[0].fileSize++;
      if (problem === "wrong-type") rows[1].fileType = "text/plain";
      if (problem === "empty-type") rows[0].fileType = "";
      if (problem === "duplicate-id") rows[1].id = rows[0].id;
      return Response.json({ attachments: rows }, { status: 201 });
    }) as unknown as typeof fetch;
    try {
      let failure: unknown;
      try {
        await uploadAttachments({ conversationId: "synthetic", files });
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof DocumentInputError && failure.code === "document_upload").toBe(
        true,
      );
    } finally {
      globalThis.fetch = previous;
    }
  });
