import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryDocument } from "shared/types";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-library-ocr-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "test.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
const originalFetch = globalThis.fetch;
let calls = 0;
let respond: (init: RequestInit) => Promise<Response> = async () =>
  Response.json(
    result("<｜ref｜>Shipping body survives<｜/ref｜><｜box｜>[[1, 2, 3, 4]]<｜/box｜>"),
  );
function result(text: string) {
  return {
    object: "ocr.result",
    purpose: "text_recognition",
    page_count: 1,
    pages: [{ index: 0, text, finish_reason: "stop" }],
  };
}
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), "https://api.deepseek.com/v1/tools/ocr");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-tools-only");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.body instanceof FormData, true);
    const form = init?.body as FormData;
    assert.deepEqual([...form.keys()].sort(), ["file", "purpose"]);
    assert.equal(form.get("purpose"), "text_recognition");
    assert.equal(form.get("file") instanceof File, true);
    calls++;
    return respond(init as RequestInit);
  },
  { preconnect() {} },
);
const { db, client } = await import("../db");
let checks = 0;
const check = (actual: unknown, expected: unknown) => {
  assert.deepEqual(actual, expected);
  checks++;
};
try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase({ backup: null });
  const { Hono } = await import("hono");
  const { libraryDocuments, libraryChunks, users, channels } = await import("db");
  const { eq } = await import("drizzle-orm");
  const service = await import("../services/libraryService");
  const { setSettingValue } = await import("../services/settingsService");
  const { LIBRARY_LIMITS } = await import("shared/library");
  const { libraryTestPdf } = await import("./libraryPdf.fixture");
  const { default: routes } = await import("./library");
  const app = new Hono().route("/library", routes);
  const owner = String((await client.execute("SELECT id FROM users LIMIT 1")).rows[0].id);
  const other = "ocr-other";
  await db.insert(users).values({
    id: other,
    email: "ocr@test.invalid",
    username: "Other",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A model channel's credential must never become the OCR credential.
  await db.insert(channels).values({
    id: "ocr-model-channel",
    userId: owner,
    name: "Synthetic model only",
    provider: "deepseek",
    protocol: "openai",
    apiKey: "synthetic-channel-never-sent",
    baseUrl: "https://model-only.invalid/v1",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const upload = async (name: string, bytes = png) => {
    const form = new FormData();
    form.set("scope", JSON.stringify({ kind: "personal" }));
    form.set("file", new File([bytes], name));
    const response = await app.request("/library", { method: "POST", body: form });
    check(response.status, 201);
    return ((await response.json()) as { document: LibraryDocument }).document;
  };
  const ocr = async (id: string) => {
    const response = await app.request(`/library/${id}/ocr`, { method: "POST" });
    return {
      status: response.status,
      body: (await response.json()) as {
        document: LibraryDocument;
        errorCode: string;
      },
    };
  };
  const first = await upload("scan.png");
  check(first.status, "failed");
  check(first.errorCode, "library_cloud_required");
  check(first.canOcr, true);
  check(calls, 0);
  const localIndex = await app.request(`/library/${first.id}/index`, { method: "POST" });
  check(localIndex.status, 200);
  check(
    ((await localIndex.json()) as { document: LibraryDocument }).document.errorCode,
    "library_cloud_required",
  );
  check(calls, 0);
  check((await service.indexLibraryDocument(owner, first.id)).errorCode, "library_cloud_required");
  check(calls, 0);
  check((await ocr(first.id)).body.errorCode, "library_ocr_key_required");
  check(calls, 0);
  await setSettingValue(owner, "deepseek.toolsApiKey", "synthetic-tools-only");
  const foreign = await service.uploadLibraryDocument(
    other,
    { kind: "personal" },
    "other.png",
    png,
  );
  check((await ocr(foreign.document.id)).status, 404);
  check(calls, 0);
  const text = await upload("local.txt", Buffer.from("Local text only"));
  check((await ocr(text.id)).body.errorCode, "library_ocr_ready");
  check(calls, 0);
  const bad = await upload("broken.png", Buffer.from("not an image"));
  check((await ocr(bad.id)).body.errorCode, "library_ocr_format");
  check(calls, 0);
  const hugePdf = await upload("too-many.pdf", libraryTestPdf(101));
  check((await ocr(hugePdf.id)).body.errorCode, "library_pdf_limit");
  check(calls, 0);
  const done = await ocr(first.id);
  check(done.status, 200);
  check(done.body.document.status, "ready");
  check(done.body.document.canOcr, false);
  check(calls, 1);
  const detail = await service.getLibraryDocument(owner, first.id);
  check(detail.text.trim(), "Shipping body survives");
  check(
    (await service.searchLibrary(owner, { kind: "personal" }, "Shipping"))[0].documentId,
    first.id,
  );
  check((await service.getLibraryOriginal(owner, first.id)).bytes, png);
  const download = await app.request(`/library/${first.id}/original`);
  check(download.status, 200);
  check(Buffer.from(await download.arrayBuffer()), png);
  const search = await app.request("/library/search?scope=personal&q=Shipping");
  check(search.status, 200);
  check(
    ((await search.json()) as { results: Array<{ documentId: string }> }).results[0].documentId,
    first.id,
  );
  check((await ocr(first.id)).body.errorCode, "library_ocr_ready");
  check(calls, 1);
  const twoPagePdf = await upload("two-page-scan.pdf", libraryTestPdf(2, ""));
  respond = async () => Response.json(result("only one returned page"));
  check((await ocr(twoPagePdf.id)).body.document.errorCode, "library_ocr_incomplete");
  for (const [name, bytes] of [
    ["report.docx", Buffer.from("504b030400000000", "hex")],
    ["slides.ppt", Buffer.from("d0cf11e0a1b11ae100000000", "hex")],
  ] as const) {
    const document = await upload(name, bytes);
    check(document.errorCode, "library_cloud_required");
  }
  const failures: Array<[unknown, string]> = [
    [
      { error: { code: "gateway_timeout_error", message: "OCR did not finish in time" } },
      "library_ocr_timeout",
    ],
    [{ error: { code: "unknown", message: "synthetic upstream failure" } }, "library_ocr_failed"],
    [
      { ...result("partial"), pages: [{ index: 0, text: "partial", finish_reason: "length" }] },
      "library_ocr_incomplete",
    ],
    [{ ...result("missing"), page_count: 2 }, "library_ocr_incomplete"],
    [
      { ...result("bad index"), pages: [{ index: 1, text: "bad", finish_reason: "stop" }] },
      "library_ocr_incomplete",
    ],
    [
      {
        ...result("duplicated"),
        page_count: 2,
        pages: Array(2).fill({ index: 0, text: "bad", finish_reason: "stop" }),
      },
      "library_ocr_incomplete",
    ],
    [{ ...result("many"), page_count: 101 }, "library_pdf_limit"],
    [result("汉".repeat(Math.ceil(LIBRARY_LIMITS.textBytes / 3))), "library_text_limit"],
    [result(" "), "library_empty_text"],
  ];
  for (const [payload, code] of failures) {
    const document = await upload(`failure-${checks}.png`);
    respond = async () => Response.json(payload);
    const before = calls;
    const failure = await ocr(document.id);
    check(failure.body.document.status, "failed");
    check(failure.body.document.errorCode, code);
    check(calls, before + 1);
    check((await service.getLibraryOriginal(owner, document.id)).bytes, png);
    check(
      (await db.select().from(libraryChunks).where(eq(libraryChunks.documentId, document.id)))
        .length,
      0,
    );
  }
  for (const [status, code] of [
    [401, "library_ocr_key_invalid"],
    [402, "library_ocr_balance"],
    [429, "library_ocr_busy"],
    [503, "library_ocr_unavailable"],
  ] as const) {
    const document = await upload(`http-${status}.png`);
    respond = async () => Response.json({ error: { message: "synthetic" } }, { status });
    check((await ocr(document.id)).body.document.errorCode, code);
  }
  const race = await upload("race.png");
  let finish!: (response: Response) => void, enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  respond = async () => {
    enter();
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  const active = ocr(race.id);
  await entered;
  const [claim] = await db.select().from(libraryDocuments).where(eq(libraryDocuments.id, race.id));
  check((claim.leaseUntil?.getTime() ?? 0) > Date.now() + 4 * 60 * 1000, true);
  const beforeBusy = calls;
  check((await ocr(race.id)).body.errorCode, "library_index_busy");
  await assert.rejects(() => service.indexLibraryDocument(owner, race.id), {
    code: "library_index_busy",
  });
  checks++;
  check(calls, beforeBusy);
  const another = await upload("another-concurrent.png");
  check((await ocr(another.id)).body.errorCode, "library_ocr_busy");
  check(calls, beforeBusy);
  await db
    .update(libraryDocuments)
    .set({ leaseUntil: new Date(0) })
    .where(eq(libraryDocuments.id, race.id));
  finish(Response.json(result("expired response must not become ready")));
  check((await active).status, 409);
  check((await service.getLibraryDocument(owner, race.id)).status, "failed");
  check((await service.getLibraryDocument(owner, race.id)).errorCode, "library_ocr_lease_expired");
  check((await service.getLibraryOriginal(owner, race.id)).bytes, png);
  // A newer local claim wins; a cloud response cannot replace its revision/token.
  const stale = await upload("stale.png");
  const staleEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const staleWork = ocr(stale.id);
  await staleEntered;
  await db
    .update(libraryDocuments)
    .set({ leaseUntil: new Date(0) })
    .where(eq(libraryDocuments.id, stale.id));
  await service.indexLibraryDocument(owner, stale.id, async () => "newer local text");
  finish(Response.json(result("stale cloud text")));
  check((await staleWork).status, 409);
  check((await service.getLibraryDocument(owner, stale.id)).text, "newer local text");
  const staleFailure = await upload("stale-failure.png");
  const failureEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const failedWork = ocr(staleFailure.id);
  await failureEntered;
  await db
    .update(libraryDocuments)
    .set({ leaseUntil: new Date(0) })
    .where(eq(libraryDocuments.id, staleFailure.id));
  await service.indexLibraryDocument(
    owner,
    staleFailure.id,
    async () => "newer text after failed cloud claim",
  );
  finish(Response.json({ error: { code: "gateway_timeout_error" } }));
  check((await failedWork).status, 409);
  check(
    (await service.getLibraryDocument(owner, staleFailure.id)).text,
    "newer text after failed cloud claim",
  );
  const deleted = await upload("deleted.png");
  const deleteEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const deletedWork = ocr(deleted.id);
  await deleteEntered;
  const deleting = await service.getLibraryDocument(owner, deleted.id);
  const removed = await app.request(`/library/${deleting.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: deleting.revision }),
  });
  check(removed.status, 200);
  finish(Response.json(result("must not resurrect")));
  check((await deletedWork).status, 409);
  await assert.rejects(() => service.getLibraryDocument(owner, deleted.id), {
    code: "library_not_found",
  });
  checks++;
  check(
    (await db.select().from(libraryChunks).where(eq(libraryChunks.documentId, deleted.id))).length,
    0,
  );
  // User text quota is validated before paying for OCR and checked again at commit.
  const quota = await upload("quota.png");
  const quotaEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const quotaWork = ocr(quota.id);
  await quotaEntered;
  await db
    .update(libraryDocuments)
    .set({ textContent: "x".repeat(LIBRARY_LIMITS.totalTextBytes) })
    .where(eq(libraryDocuments.id, text.id));
  finish(Response.json(result("must not exceed the current user quota")));
  check((await quotaWork).body.document.errorCode, "library_text_limit");
  check((await service.getLibraryOriginal(owner, quota.id)).bytes, png);
  const beforeQuota = calls;
  check((await ocr(quota.id)).body.errorCode, "library_text_limit");
  check(calls, beforeQuota);
  console.log(JSON.stringify({ checks }));
} finally {
  globalThis.fetch = originalFetch;
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
