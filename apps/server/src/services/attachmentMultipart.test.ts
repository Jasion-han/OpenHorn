import { expect, test } from "bun:test";
import {
  type AttachmentMultipartError,
  MAX_ATTACHMENT_REQUEST_BYTES,
  parseAttachmentMultipart,
} from "./attachmentMultipart";

test("multipart parsing preserves binary NUL bytes, repeated fields and UTF-8 filenames", async () => {
  const form = new FormData();
  form.append("conversationId", "synthetic");
  const bytes = new Uint8Array([255, 216, 0, 255, 217, 0]);
  form.append("files", new File([bytes], "图表.pdf [page 2].jpg", { type: "image/jpeg" }));
  form.append("files", new File(["text"], "notes.txt", { type: "text/plain" }));
  const body = await parseAttachmentMultipart(
    new Request("http://test.local/upload", { method: "POST", body: form }),
  );
  const files = body.files as File[];
  expect(body.conversationId).toBe("synthetic");
  expect(files).toHaveLength(2);
  expect(files[0].name).toBe("图表.pdf [page 2].jpg");
  expect([...new Uint8Array(await files[0].arrayBuffer())]).toEqual([...bytes]);
});

test("attachment parser enforces the aggregate request bound before accepting files", async () => {
  let code = "";
  try {
    await parseAttachmentMultipart(
      new Request("http://test.local", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=fixture",
          "content-length": String(MAX_ATTACHMENT_REQUEST_BYTES + 1),
        },
        body: "tiny",
      }),
    );
  } catch (error) {
    code = (error as AttachmentMultipartError).code;
  }
  expect(code).toBe("attachment_payload_too_large");
});

test("missing boundaries and unexpected file fields fail before storing any originals", async () => {
  for (const request of [
    new Request("http://test.local", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "invalid",
    }),
    (() => {
      const form = new FormData();
      form.append("unexpected", new File(["x"], "x.txt"));
      return new Request("http://test.local", { method: "POST", body: form });
    })(),
  ]) {
    let code = "";
    try {
      await parseAttachmentMultipart(request);
    } catch (error) {
      code = (error as AttachmentMultipartError).code;
    }
    expect(code).toBe("invalid_attachment_multipart");
  }
});

for (const limit of ["files", "fields", "file-bytes"])
  test(`multipart ${limit} limit refuses the complete batch`, async () => {
    const form = new FormData();
    if (limit === "files")
      for (let index = 0; index < 21; index++)
        form.append("files", new File(["x"], `${index}.txt`));
    if (limit === "fields")
      for (let index = 0; index < 17; index++) form.append(`field-${index}`, "x");
    if (limit === "file-bytes")
      form.append(
        "files",
        new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" }),
      );
    let code = "";
    try {
      await parseAttachmentMultipart(
        new Request("http://test.local", { method: "POST", body: form }),
      );
    } catch (error) {
      code = (error as AttachmentMultipartError).code;
    }
    expect(code).toBe("attachment_payload_too_large");
  });
