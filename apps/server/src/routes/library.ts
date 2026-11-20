import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIBRARY_LIMITS } from "shared/library";
import type { LibraryScope, LibrarySearchMatchRequest } from "shared/types";
import {
  createLibraryFolder,
  deleteLibraryDocument,
  deleteLibraryFolder,
  deleteLibraryQuestion,
  getLibraryDocument,
  getLibraryOriginal,
  getLibraryQuestion,
  getLibraryStats,
  getSourceForLibraryConversation,
  indexLibraryDocument,
  LibraryError,
  listLibraryDocuments,
  listLibraryDocumentVersions,
  listLibraryFolders,
  listLibraryQuestions,
  moveLibraryDocuments,
  ocrLibraryDocument,
  parseLibraryScope,
  prepareLibraryQuestion,
  renameLibraryFolder,
  restoreLibraryDocument,
  searchLibrary,
  updateLibraryDocumentMetadata,
  uploadLibraryDocument,
} from "../services/libraryService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();
router.use("*", requireUser);
router.use(
  "*",
  bodyLimit({
    maxSize: LIBRARY_LIMITS.fileBytes + 64 * 1024,
    onError: (c) => c.json({ errorCode: "library_file_limit" }, 413),
  }),
);
router.onError((error, c) => {
  if (error instanceof LibraryError) return c.json({ errorCode: error.code }, error.status);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return c.json({ errorCode: "library_invalid_data" }, 400);
  console.error("Library operation failed", error.name);
  return c.json({ errorCode: "library_unavailable" }, 500);
});
const queryScope = (kind?: string, projectId?: string) =>
  parseLibraryScope({ kind: kind ?? "personal", projectId }, true);
const organizationFilters = (favorite?: string, tag?: string, folderId?: string) => ({
  favoriteOnly: favorite === "true",
  tag: tag?.trim(),
  folderId: folderId === "" ? null : folderId,
});
router.get("/", async (c) => {
  const scope = queryScope(c.req.query("scope"), c.req.query("projectId"));
  const [documents, stats, folders] = await Promise.all([
    listLibraryDocuments(
      c.get("user").id,
      scope,
      organizationFilters(c.req.query("favorite"), c.req.query("tag"), c.req.query("folderId")),
    ),
    getLibraryStats(c.get("user").id, scope),
    listLibraryFolders(c.get("user").id, scope),
  ]);
  return c.json({ documents, stats, folders });
});
router.get("/search", async (c) => {
  const documentId = c.req.query("documentId");
  const index = c.req.query("matchIndex");
  const expectedRevision = c.req.query("revision");
  let match: LibrarySearchMatchRequest | undefined;
  if (documentId !== undefined || index !== undefined || expectedRevision !== undefined) {
    if (!documentId || !index || !expectedRevision) throw new LibraryError("library_invalid_data");
    match = { documentId, index: Number(index), revision: Number(expectedRevision) };
  }
  return c.json({
    results: await searchLibrary(
      c.get("user").id,
      queryScope(c.req.query("scope"), c.req.query("projectId")),
      c.req.query("q") ?? "",
      organizationFilters(c.req.query("favorite"), c.req.query("tag"), c.req.query("folderId")),
      match,
    ),
  });
});
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new LibraryError("library_invalid_data");
  return value;
}
router.post("/folders", async (c) => {
  const { name, scope } = await c.req.json();
  return c.json(
    await createLibraryFolder(c.get("user").id, parseLibraryScope(scope) as LibraryScope, name),
    201,
  );
});
router.patch("/folders/:id", async (c) => {
  const { name, expectedRevision } = await c.req.json();
  return c.json({
    folder: await renameLibraryFolder(
      c.get("user").id,
      c.req.param("id"),
      revision(expectedRevision),
      name,
    ),
  });
});
router.delete("/folders/:id", async (c) => {
  const { expectedRevision } = await c.req.json();
  return c.json({
    success: await deleteLibraryFolder(
      c.get("user").id,
      c.req.param("id"),
      revision(expectedRevision),
    ),
  });
});
router.post("/documents/move", async (c) =>
  c.json(await moveLibraryDocuments(c.get("user").id, await c.req.json())),
);
router.get("/conversations/:id/source", async (c) => {
  const chunkIndex = c.req.query("chunkIndex");
  if (chunkIndex === undefined || !/^(0|[1-9]\d*)$/.test(chunkIndex))
    throw new LibraryError("library_invalid_question");
  return c.json({
    source: await getSourceForLibraryConversation(c.get("user").id, c.req.param("id"), {
      documentId: c.req.query("documentId"),
      chunkIndex: Number(chunkIndex),
      revision: Number(c.req.query("revision")),
    }),
  });
});
router.get("/questions", async (c) =>
  c.json({ questions: await listLibraryQuestions(c.get("user").id) }),
);
router.post("/questions", async (c) =>
  c.json(await prepareLibraryQuestion(c.get("user").id, await c.req.json()), 201),
);
router.get("/questions/:id", async (c) =>
  c.json(await getLibraryQuestion(c.get("user").id, c.req.param("id"))),
);
router.delete("/questions/:id", async (c) =>
  c.json({ success: await deleteLibraryQuestion(c.get("user").id, c.req.param("id")) }),
);
router.post("/", async (c) => {
  const form = await c.req.formData(),
    file = form.get("file");
  if (!(file instanceof File) || !file.size || file.size > LIBRARY_LIMITS.fileBytes)
    throw new LibraryError("library_file_limit", 413);
  const scope = parseLibraryScope(JSON.parse(String(form.get("scope") ?? "{}"))) as LibraryScope;
  const rawFolderId = form.get("folderId");
  if (rawFolderId !== null && typeof rawFolderId !== "string")
    throw new LibraryError("library_invalid_data");
  const folderId = typeof rawFolderId === "string" ? rawFolderId || null : undefined;
  return c.json(
    await uploadLibraryDocument(
      c.get("user").id,
      scope,
      file.name,
      Buffer.from(await file.arrayBuffer()),
      folderId,
    ),
    201,
  );
});
router.get("/:id/original", async (c) => {
  const original = await getLibraryOriginal(c.get("user").id, c.req.param("id"));
  return new Response(new Uint8Array(original.bytes), {
    headers: {
      "Content-Type": original.fileType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(original.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
router.get("/:id/versions", async (c) =>
  c.json({ versions: await listLibraryDocumentVersions(c.get("user").id, c.req.param("id")) }),
);
router.get("/:id", async (c) =>
  c.json({ document: await getLibraryDocument(c.get("user").id, c.req.param("id")) }),
);
router.patch("/:id", async (c) =>
  c.json({
    document: await updateLibraryDocumentMetadata(
      c.get("user").id,
      c.req.param("id"),
      await c.req.json(),
    ),
  }),
);
router.post("/:id/index", async (c) =>
  c.json({ document: await indexLibraryDocument(c.get("user").id, c.req.param("id")) }),
);
router.post("/:id/restore", async (c) => {
  const { expectedRevision } = await c.req.json();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new LibraryError("library_invalid_data");
  return c.json({
    document: await restoreLibraryDocument(c.get("user").id, c.req.param("id"), expectedRevision),
  });
});
router.post("/:id/ocr", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json({
    document: await ocrLibraryDocument(
      c.get("user").id,
      c.req.param("id"),
      typeof body?.connectionToken === "string" ? body.connectionToken : undefined,
    ),
  });
});
router.delete("/:id", async (c) => {
  const { expectedRevision } = await c.req.json();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new LibraryError("library_invalid_data");
  return c.json({
    success: await deleteLibraryDocument(c.get("user").id, c.req.param("id"), expectedRevision),
  });
});
export default router;
