import { Hono } from "hono";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
} from "../services/projectService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();

router.use("*", requireUser);

router.get("/", async (c) => {
  const user = c.get("user");
  const projects = await listProjects(user.id);
  return c.json({ projects });
});

router.post("/", async (c) => {
  const user = c.get("user");
  try {
    const body = await c.req.json<{ name?: string; rootPath?: string }>();
    if (!body.name?.trim() || !body.rootPath?.trim()) {
      return c.json({ error: "name and rootPath are required" }, 400);
    }
    const project = await createProject(user.id, { name: body.name, rootPath: body.rootPath });
    return c.json({ project }, 201);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to create project" },
      400,
    );
  }
});

router.put("/:id", async (c) => {
  const user = c.get("user");
  try {
    const body = await c.req.json<{ name?: string; isStarred?: boolean }>();
    const project = await updateProject(user.id, c.req.param("id"), body);
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ project });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to update project" },
      400,
    );
  }
});

router.delete("/:id", async (c) => {
  const user = c.get("user");
  const removed = await deleteProject(user.id, c.req.param("id"));
  if (!removed) return c.json({ error: "Project not found" }, 404);
  return c.json({ success: true });
});

export default router;
