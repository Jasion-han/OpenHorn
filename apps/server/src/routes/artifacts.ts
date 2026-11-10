import { Hono } from "hono";
import {
  ArtifactServiceError,
  appendArtifactVersion,
  createArtifact,
  deleteArtifact,
  getArtifactDetail,
  listArtifacts,
  restoreArtifact,
  updateArtifact,
} from "../services/artifactService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();
router.use("*", requireUser);

router.onError((error, c) => {
  if (error instanceof ArtifactServiceError) {
    return c.json({ errorCode: error.code, error: error.message }, error.status);
  }
  if (error instanceof SyntaxError) {
    return c.json({ errorCode: "invalid_artifact", error: "Invalid artifact request" }, 400);
  }
  return c.json({ errorCode: "invalid_artifact", error: "Artifact request failed" }, 500);
});

router.get("/", async (c) => c.json({ artifacts: await listArtifacts(c.get("user").id) }));

router.post("/", async (c) => {
  const saved = await createArtifact(c.get("user").id, await c.req.json());
  return c.json(saved, 201);
});

router.get("/:id", async (c) => {
  const rawVersion = c.req.query("version");
  const version = rawVersion === undefined ? undefined : Number(rawVersion);
  return c.json(await getArtifactDetail(c.get("user").id, c.req.param("id"), version));
});

router.post("/:id/versions", async (c) => {
  const saved = await appendArtifactVersion(
    c.get("user").id,
    c.req.param("id"),
    await c.req.json(),
  );
  return c.json(saved, 201);
});
router.post("/:id/restore", async (c) => {
  const body: unknown = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ArtifactServiceError("invalid_artifact", 400);
  const input = body as Record<string, unknown>;
  return c.json(
    await restoreArtifact(
      c.get("user").id,
      c.req.param("id"),
      input.sourceVersion,
      input.expectedVersion,
    ),
  );
});

router.patch("/:id", async (c) => {
  const artifact = await updateArtifact(c.get("user").id, c.req.param("id"), await c.req.json());
  return c.json({ artifact });
});

router.delete("/:id", async (c) =>
  c.json({ success: await deleteArtifact(c.get("user").id, c.req.param("id")) }),
);

export default router;
