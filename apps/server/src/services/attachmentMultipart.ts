import Busboy from "busboy";
import { MAX_ATTACHMENT_SIZE } from "./attachmentLimits";

export const MAX_ATTACHMENT_REQUEST_BYTES = 64 * 1024 * 1024;
export class AttachmentMultipartError extends Error {
  constructor(readonly code: "invalid_attachment_multipart" | "attachment_payload_too_large") {
    super(code);
  }
}
type Body = Record<string, string | string[] | File[] | undefined>;

/** Bounded byte parsing avoids Bun 1.3.10 formData() truncation at binary NULs. */
export async function parseAttachmentMultipart(request: Request): Promise<Body> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type) || !request.body)
    throw new AttachmentMultipartError("invalid_attachment_multipart");
  if (Number(request.headers.get("content-length")) > MAX_ATTACHMENT_REQUEST_BYTES)
    throw new AttachmentMultipartError("attachment_payload_too_large");
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: { "content-type": type },
      preservePath: true,
      defParamCharset: "utf8",
      limits: { files: 20, fileSize: MAX_ATTACHMENT_SIZE, fields: 16, fieldSize: 2048, parts: 36 },
    });
  } catch {
    throw new AttachmentMultipartError("invalid_attachment_multipart");
  }

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_ATTACHMENT_REQUEST_BYTES)
        throw new AttachmentMultipartError("attachment_payload_too_large");
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    parser.destroy();
    throw error;
  } finally {
    reader.releaseLock();
  }
  request.signal.throwIfAborted();
  const wire = Buffer.concat(chunks);
  return new Promise<Body>((resolve, reject) => {
    const fields: Body = Object.create(null);
    const files: Array<{ index: number; file: File }> = [];
    let sequence = 0;
    let failed: AttachmentMultipartError | undefined;
    const tooLarge = () => {
      failed = new AttachmentMultipartError("attachment_payload_too_large");
    };
    parser.on("filesLimit", tooLarge).on("fieldsLimit", tooLarge).on("partsLimit", tooLarge);
    parser.on("field", (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) {
        tooLarge();
        return;
      }
      if (name === "files") {
        failed = new AttachmentMultipartError("invalid_attachment_multipart");
        return;
      }
      const previous = fields[name];
      fields[name] =
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...(previous as string[]), value]
            : [previous as string, value];
    });
    parser.on("file", (name, stream, info) => {
      const index = sequence++;
      const data: Buffer[] = [];
      if (name !== "files" || !info.filename) {
        failed = new AttachmentMultipartError("invalid_attachment_multipart");
        stream.resume();
      } else {
        stream.on("data", (chunk: Buffer) => data.push(chunk));
      }
      stream.on("limit", tooLarge);
      stream.on("error", () => {
        failed = new AttachmentMultipartError("invalid_attachment_multipart");
      });
      stream.on("end", () => {
        if (failed || stream.truncated) return;
        files.push({
          index,
          file: new File([new Uint8Array(Buffer.concat(data))], info.filename, {
            type: info.mimeType,
          }),
        });
      });
    });
    parser.once("error", () =>
      reject(new AttachmentMultipartError("invalid_attachment_multipart")),
    );
    parser.once("close", () => {
      if (failed) {
        reject(failed);
        return;
      }
      fields.files = files.sort((a, b) => a.index - b.index).map((entry) => entry.file);
      resolve(fields);
    });
    parser.end(wire);
  });
}
