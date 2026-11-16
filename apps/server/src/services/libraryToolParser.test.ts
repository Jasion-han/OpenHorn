import { expect, test } from "bun:test";
import { parseOpenRouterDocument, requestLibraryToolParse } from "./libraryToolParser";

const payload = (file: unknown, finish_reason = "stop") => ({
  choices: [
    {
      finish_reason,
      message: {
        content: "Invented summary must never be indexed",
        annotations: [{ type: "file", file }],
      },
    },
  ],
});
const file = {
  hash: "parsed-hash",
  name: "scan.pdf",
  content: [{ type: "text", text: "Exact source text" }],
};

test("OpenRouter document parsing accepts parser text and never model summaries", () => {
  expect(parseOpenRouterDocument(payload(file), "scan.pdf")).toBe("Exact source text");
  for (const value of [
    { choices: [{ finish_reason: "stop", message: { content: "Invented OCR" } }] },
    payload(file, "length"),
    payload({ ...file, name: "different.pdf" }),
    payload({ ...file, content: [{ type: "image_url", image_url: { url: "data:..." } }] }),
    payload({ ...file, content: [{ type: "text", text: "" }] }),
    payload({ ...file, content: [{ type: "text", text: "bad\u0000text" }] }),
  ])
    expect(() => parseOpenRouterDocument(value, "scan.pdf")).toThrow();
});

test("OpenRouter rejects unsupported image and Office formats before an external request", async () => {
  for (const type of ["image/png", "application/msword"])
    await expect(
      requestLibraryToolParse(Buffer.from("generated"), "scan.png", type, {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "generated-key",
        model: "test/model",
      }),
    ).rejects.toThrow("library_ocr_format");
});

test("compatible OCR relay sends multipart bytes only to its configured endpoint", async () => {
  const connection = {
    kind: "deepseek" as const,
    baseUrl: "https://relay.example.com/api/v1",
    apiKey: "ocr-relay-only",
  };
  let calls = 0;
  const result = await requestLibraryToolParse(
    Buffer.from("generated-image"),
    "scan.png",
    "image/png",
    connection,
    1,
    {
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://relay.example.com/api/v1/tools/ocr");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ocr-relay-only");
        expect(init?.redirect).toBe("error");
        expect(await ((init?.body as FormData).get("file") as File).text()).toBe("generated-image");
        return new Response(
          JSON.stringify({
            object: "ocr.result",
            purpose: "text_recognition",
            page_count: 1,
            pages: [{ index: 0, text: "Exact OCR", finish_reason: "stop" }],
          }),
        );
      },
    },
  );
  expect(result).toBe("Exact OCR");
  expect(calls).toBe(1);
  await expect(
    requestLibraryToolParse(Buffer.from("private"), "scan.png", "image/png", connection, 1, {
      resolveHostname: async () => ["10.0.0.1"],
      fetchImpl: async () => {
        calls++;
        return new Response();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("OpenRouter PDF requests file-parser and indexes only its returned annotation", async () => {
  const text = await requestLibraryToolParse(
    Buffer.from("generated-pdf"),
    "scan.pdf",
    "application/pdf",
    {
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "router-pdf-only",
      model: "test/model",
    },
    1,
    {
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "mistral-ocr" } }]);
        expect(body.messages[0].content[1].file.filename).toBe("scan.pdf");
        return new Response(JSON.stringify(payload(file)));
      },
    },
  );
  expect(text).toBe("Exact source text");
});
