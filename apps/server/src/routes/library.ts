import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIBRARY_LIMITS } from "shared/library";
import type { LibraryScope } from "shared/types";
import {
  deleteLibraryDocument,
  deleteLibraryQuestion,
  getLibraryDocument,
  getLibraryOriginal,
  getLibraryQuestion,
  indexLibraryDocument,
  LibraryError,
  listLibraryDocuments,
  listLibraryQuestions,
  ocrLibraryDocument,
  parseLibraryScope,
  prepareLibraryQuestion,
  searchLibrary,
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
router.get("/", async (c) =>
  c.json({
    documents: await listLibraryDocuments(
      c.get("user").id,
      queryScope(c.req.query("scope"), c.req.query("projectId")),
    ),
  }),
);
router.get("/search", async (c) =>
  c.json({
    results: await searchLibrary(
      c.get("user").id,
      queryScope(c.req.query("scope"), c.req.query("projectId")),
      c.req.query("q") ?? "",
    ),
  }),
);
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
  return c.json(
    await uploadLibraryDocument(
      c.get("user").id,
      scope,
      file.name,
      Buffer.from(await file.arrayBuffer()),
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
router.get("/:id", async (c) =>
  c.json({ document: await getLibraryDocument(c.get("user").id, c.req.param("id")) }),
);
router.post("/:id/index", async (c) =>
  c.json({ document: await indexLibraryDocument(c.get("user").id, c.req.param("id")) }),
);
router.post("/:id/ocr", async (c) =>
  c.json({ document: await ocrLibraryDocument(c.get("user").id, c.req.param("id")) }),
);
router.delete("/:id", async (c) => {
  const { expectedRevision } = await c.req.json();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new LibraryError("library_invalid_data");
  return c.json({
    success: await deleteLibraryDocument(c.get("user").id, c.req.param("id"), expectedRevision),
  });
});
export default router;
