import { afterEach, expect, test } from "bun:test";
import { LIBRARY_LIMITS, libraryFileType } from "shared/library";
import { cleanLibraryOcrText, parseLibraryOcrResult, requestLibraryOcr } from "./libraryOcr";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});
const page = (index: number, text: string) => ({ index, text, finish_reason: "stop" });
const result = (pages: unknown[]) => ({
  object: "ocr.result",
  purpose: "text_recognition",
  page_count: pages.length,
  pages,
});
const fakeFetch = (work: () => Promise<Response>) => {
  globalThis.fetch = Object.assign(work, { preconnect() {} }) as typeof fetch;
};
test("OCR extension additions do not admit inherited object property names", () => {
  expect(libraryFileType("file.constructor")).toBe(null);
  expect(libraryFileType("file.__proto__")).toBe(null);
});

test("OCR keeps ref contents and normal prose, removing only localization markup", () => {
  expect(
    cleanLibraryOcrText(
      "Before <｜ref｜>heading and full body<｜/ref｜><｜box｜>[[1,2,3,4]]<｜/box｜> after",
    ),
  ).toBe("Before heading and full body after");
  expect(cleanLibraryOcrText("<｜box｜>actual body, not coordinates<｜/box｜>")).toBe(
    "actual body, not coordinates",
  );
});
test("OCR orders complete page indices and preserves all pages", () => {
  expect(parseLibraryOcrResult(result([page(1, "second"), page(0, "first")]))).toBe(
    "first\n\nsecond",
  );
  expect(parseLibraryOcrResult(result([page(0, ""), page(1, "body")]))).toBe("\n\nbody");
});
test("OCR validates every page and strict page count types", () => {
  for (const payload of [
    result([]),
    { ...result([page(0, "body")]), page_count: "1" },
    result([page(-1, "body")]),
    result([page(0.5, "body")]),
    result([{ ...page(0, "body"), finish_reason: "error" }]),
    result([{ ...page(0, "body"), text: null }]),
    { ...result([page(0, "body")]), purpose: "rich_layout_recognition" },
  ]) {
    let code = "";
    try {
      parseLibraryOcrResult(payload);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe("library_ocr_incomplete");
  }
});
test("OCR rejects binary controls instead of indexing damaged text", () => {
  let code = "";
  try {
    parseLibraryOcrResult(result([page(0, "body\u0000damaged")]));
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_invalid_text");
});
test("OCR counts UTF-8 bytes and page separators in the 2 MiB limit", () => {
  expect(
    parseLibraryOcrResult(result([page(0, "x".repeat(LIBRARY_LIMITS.textBytes))])).length,
  ).toBe(LIBRARY_LIMITS.textBytes);
  let code = "";
  try {
    parseLibraryOcrResult(result([page(0, "x".repeat(LIBRARY_LIMITS.textBytes)), page(1, "")]));
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_text_limit");
});
test("OCR timeout covers a hanging fetch and never retries", async () => {
  let calls = 0,
    configured = 0;
  AbortSignal.timeout = (ms: number) => {
    configured = ms;
    return originalTimeout(5);
  };
  fakeFetch(async () => {
    calls++;
    return new Promise<Response>(() => {});
  });
  let code = "";
  try {
    await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic");
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(configured).toBe(180000);
  expect(code).toBe("library_ocr_timeout");
  expect(calls).toBe(1);
});
test("OCR timeout includes newline keepalives and a stalled response body", async () => {
  AbortSignal.timeout = () => originalTimeout(10);
  let cancelled = false;
  fakeFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  let code = "";
  try {
    await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic");
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_ocr_timeout");
  expect(cancelled).toBe(true);
});
test("OCR accepts leading keepalive whitespace and rejects invalid JSON", async () => {
  fakeFetch(async () => new Response(`\n\n${JSON.stringify(result([page(0, "complete body")]))}`));
  expect(await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic")).toBe(
    "complete body",
  );
  fakeFetch(async () => new Response("partial JSON"));
  let code = "";
  try {
    await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic");
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_ocr_failed");
});
test("OCR rejects invalid UTF-8 rather than replacing body characters", async () => {
  const wire = Buffer.concat([
    Buffer.from(
      '{"object":"ocr.result","purpose":"text_recognition","page_count":1,"pages":[{"index":0,"finish_reason":"stop","text":"',
    ),
    Buffer.from([0xff]),
    Buffer.from('"}]}'),
  ]);
  fakeFetch(async () => new Response(wire));
  let code = "";
  try {
    await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic");
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_ocr_failed");
});
test("OCR bounds wire body even if it contains only keepalive whitespace", async () => {
  let cancelled = false;
  fakeFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  let code = "";
  try {
    await requestLibraryOcr(Buffer.from("test"), "test.png", "image/png", "synthetic");
  } catch (error) {
    code = (error as { code: string }).code;
  }
  expect(code).toBe("library_text_limit");
  expect(cancelled).toBe(true);
});
