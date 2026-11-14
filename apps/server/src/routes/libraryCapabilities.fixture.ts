import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryDocument, LibraryDocumentDetail } from "shared/types";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-library-capabilities-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "test.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
const originalFetch = globalThis.fetch;
const { db, client } = await import("../db");
let server: ReturnType<typeof Bun.serve> | undefined;
let checks = 0;
let cloudRequests = 0;
const check = (actual: unknown, expected: unknown, message?: string) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};
try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase({ backup: null });
  const { Hono } = await import("hono");
  const { libraryDocuments } = await import("db");
  const { eq } = await import("drizzle-orm");
  const { libraryTestPdf } = await import("./libraryPdf.fixture");
  const { default: routes } = await import("./library");
  const app = new Hono().route("/library", routes);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const origin = server.url.origin;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== origin) {
        cloudRequests++;
        throw new Error("External requests forbidden in capability fixture");
      }
      return originalFetch(input, init);
    },
    { preconnect() {} },
  );
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const upload = async (name: string, bytes: Buffer) => {
    const form = new FormData();
    form.set("scope", JSON.stringify({ kind: "personal" }));
    form.set("file", new File([bytes], name));
    const response = await fetch(`${origin}/library`, { method: "POST", body: form });
    check(response.status, 201);
    return ((await response.json()) as { document: LibraryDocument }).document;
  };
  const detail = async (id: string) => {
    const response = await fetch(`${origin}/library/${id}`);
    check(response.status, 200);
    return ((await response.json()) as { document: LibraryDocumentDetail }).document;
  };
  const capabilities = (document: LibraryDocument, canIndex: boolean, canOcr: boolean) =>
    check(
      { canIndex: document.canIndex, canOcr: document.canOcr },
      { canIndex, canOcr },
      document.fileName,
    );
  const state = async (
    id: string,
    status: "failed" | "indexing" | "ready",
    leaseUntil: Date | null,
  ) => {
    await db
      .update(libraryDocuments)
      .set({ status, leaseUntil, indexToken: "capability-claim" })
      .where(eq(libraryDocuments.id, id));
  };
  const localIndex = (id: string) => fetch(`${origin}/library/${id}/index`, { method: "POST" });
  const scenario = process.argv[2];
  if (scenario === "cloud-only") {
    for (const ext of [
      "doc",
      "docx",
      "ppt",
      "pptx",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
      "bmp",
      "tif",
      "tiff",
    ]) {
      const bytes =
        ext === "doc" || ext === "ppt"
          ? Buffer.from("d0cf11e0a1b11ae1", "hex")
          : ext === "docx" || ext === "pptx"
            ? Buffer.from("504b030400000000", "hex")
            : png;
      const document = await upload(`cloud-only.${ext}`, bytes);
      check(document.status, "failed");
      check(document.errorCode, "library_cloud_required");
      console.log(
        JSON.stringify({
          fileName: document.fileName,
          canIndex: document.canIndex,
          canOcr: document.canOcr,
        }),
      );
      capabilities(document, false, true);
      capabilities(await detail(document.id), false, true);
      // Direct legacy callers still get an honest local failure, never an implicit paid OCR.
      const retry = await localIndex(document.id);
      check(retry.status, 200);
      const retried = ((await retry.json()) as { document: LibraryDocument }).document;
      check(retried.errorCode, "library_cloud_required");
      capabilities(retried, false, true);
    }
    const response = await fetch(`${origin}/library?scope=personal`);
    check(response.status, 200);
    const documents = ((await response.json()) as { documents: LibraryDocument[] }).documents;
    check(documents.length, 12);
    for (const document of documents) capabilities(document, false, true);
  } else if (scenario === "local") {
    const text = await upload("local.txt", Buffer.from("Local searchable document"));
    const pdf = await upload("text-layer.pdf", libraryTestPdf(1));
    for (const document of [text, pdf]) {
      check(document.status, "ready");
      capabilities(document, true, false);
      const retry = await localIndex(document.id);
      check(retry.status, 200);
      capabilities(((await retry.json()) as { document: LibraryDocument }).document, true, false);
    }
    const scan = await upload("scan.pdf", libraryTestPdf(1, ""));
    check(scan.errorCode, "library_empty_text");
    capabilities(scan, true, true);
    const retriedScan = await localIndex(scan.id);
    check(retriedScan.status, 200);
    const scanFailure = ((await retriedScan.json()) as { document: LibraryDocument }).document;
    check(scanFailure.errorCode, "library_empty_text");
    capabilities(scanFailure, true, true);
    const search = await fetch(`${origin}/library/search?scope=personal&q=searchable`);
    check(
      ((await search.json()) as { results: Array<{ documentId: string }> }).results[0].documentId,
      text.id,
    );
  } else if (scenario === "leases") {
    for (const [name, bytes, local, cloud] of [
      ["lease.txt", Buffer.from("local text"), true, false],
      ["lease.pdf", libraryTestPdf(1), true, true],
      ["lease.png", png, false, true],
      ["lease.docx", Buffer.from("504b030400000000", "hex"), false, true],
    ] as const) {
      const document = await upload(name, bytes);
      await state(document.id, "indexing", new Date(Date.now() + 300000));
      const busy = await detail(document.id);
      capabilities(busy, false, false);
      const rejected = await localIndex(document.id);
      check(rejected.status, 409);
      check(((await rejected.json()) as { errorCode: string }).errorCode, "library_index_busy");
      check((await detail(document.id)).revision, busy.revision);
      await state(document.id, "indexing", new Date(0));
      capabilities(await detail(document.id), local, cloud);
      await state(document.id, "indexing", null);
      capabilities(await detail(document.id), local, cloud);
      await state(document.id, "ready", null);
      capabilities(await detail(document.id), local, false);
    }
    // An expired PDF claim can actually be retried locally, not only advertised as retryable.
    const pdf = await upload("expired-retry.pdf", libraryTestPdf(1));
    await state(pdf.id, "indexing", new Date(0));
    const retry = await localIndex(pdf.id);
    check(retry.status, 200);
    const indexed = ((await retry.json()) as { document: LibraryDocument }).document;
    check(indexed.status, "ready");
    capabilities(indexed, true, false);
    check(indexed.revision, pdf.revision + 1);
  } else throw new Error("Unknown capability fixture scenario");
  check(cloudRequests, 0);
  console.log(JSON.stringify({ scenario, checks, cloudRequests }));
} finally {
  server?.stop(true);
  globalThis.fetch = originalFetch;
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
