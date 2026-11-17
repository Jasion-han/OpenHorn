import { expect, test } from "bun:test";
import { uploadAttachments } from "./attachments";
import { DocumentInputError } from "./documentInput";

for (const problem of ["missing", "wrong-name", "wrong-size", "duplicate-id"])
  test(`upload refuses ${problem} instead of sending an incomplete PDF/page context`, async () => {
    const previous = globalThis.fetch;
    const files = [
      new File(["pdf"], "source.pdf", { type: "application/pdf" }),
      new File(["jpeg"], "source.pdf [page 1].jpg", { type: "image/jpeg" }),
    ];
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect((init?.body as FormData).getAll("files")).toHaveLength(2);
      const rows = files.map((file, index) => ({
        id: String(index),
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      }));
      if (problem === "missing") rows.pop();
      if (problem === "wrong-name") rows[0].fileName = "different.pdf";
      if (problem === "wrong-size") rows[0].fileSize++;
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
