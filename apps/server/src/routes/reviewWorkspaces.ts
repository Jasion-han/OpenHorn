import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { REVIEW_LIMITS, ReviewValidationError } from "shared/reviews";
import { classifyReviewBatch } from "../services/reviewDecisionService";
import { ReviewNoteVerificationError } from "../services/reviewNoteVerification";
import {
  createReviewWorkspace,
  deleteReviewWorkspace,
  getReviewWorkspace,
  importReviewRun,
  listReviewWorkspaces,
  prepareReviewRun,
  ReviewWorkspaceError,
  updateReviewAnnotation,
  verifyReviewNote,
} from "../services/reviewWorkspaceService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();
router.use("*", requireUser);
router.use(
  "*",
  bodyLimit({
    maxSize: REVIEW_LIMITS.documentBytes,
    onError: (c) => c.json({ errorCode: "review_limit" }, 413),
  }),
);
router.onError((error, c) => {
  if (error instanceof ReviewNoteVerificationError)
    return c.json({ errorCode: error.code }, error.status);
  if (error instanceof ReviewWorkspaceError) return c.json({ errorCode: error.code }, error.status);
  if (error instanceof ReviewValidationError) return c.json({ errorCode: error.code }, 400);
  if (error instanceof SyntaxError || error instanceof TypeError)
    return c.json({ errorCode: "review_invalid_data" }, 400);
  console.error("Review workspace operation failed", error.name);
  return c.json({ errorCode: "review_unavailable" }, 500);
});
router.get("/", async (c) => c.json({ workspaces: await listReviewWorkspaces(c.get("user").id) }));
router.post("/", async (c) =>
  c.json({ workspace: await createReviewWorkspace(c.get("user").id, await c.req.json()) }, 201),
);
router.get("/:id", async (c) =>
  c.json({ workspace: await getReviewWorkspace(c.get("user").id, c.req.param("id")) }),
);
router.delete("/:id", async (c) =>
  c.json({
    success: await deleteReviewWorkspace(
      c.get("user").id,
      c.req.param("id"),
      (await c.req.json()).expectedRevision,
    ),
  }),
);
router.patch("/:id/rows/:rowId", async (c) =>
  c.json({
    workspace: await updateReviewAnnotation(
      c.get("user").id,
      c.req.param("id"),
      c.req.param("rowId"),
      await c.req.json(),
    ),
  }),
);
router.post("/:id/rows/:rowId/verify-note", async (c) =>
  c.json(
    await verifyReviewNote(
      c.get("user").id,
      c.req.param("id"),
      c.req.param("rowId"),
      await c.req.json(),
    ),
  ),
);
router.post("/:id/jev-runs", async (c) =>
  c.json(await classifyReviewBatch(c.get("user").id, c.req.param("id"), await c.req.json())),
);
router.post("/:id/runs", async (c) =>
  c.json(await prepareReviewRun(c.get("user").id, c.req.param("id"), await c.req.json()), 201),
);
router.post("/:id/runs/:runId/import", async (c) =>
  c.json({
    workspace: await importReviewRun(
      c.get("user").id,
      c.req.param("id"),
      c.req.param("runId"),
      (await c.req.json()).expectedRevision,
    ),
  }),
);
export default router;
