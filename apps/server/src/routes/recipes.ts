import { type Context, Hono } from "hono";
import { RecipeValidationError } from "shared/recipes";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  prepareRecipe,
  recipeError,
  restoreRecipe,
  scheduleRecipe,
  updateRecipe,
} from "../services/recipeService";
import { rescheduleScheduler } from "../services/scheduledTaskScheduler";
import { requireUser, type UserEnv } from "../utils/requestUser";

async function bodyObject(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RecipeValidationError("invalid_recipe", "JSON object is required");
  return body as Record<string, unknown>;
}
const router = new Hono<UserEnv>();
router.use("*", requireUser);
router.onError((error, c) => {
  const result = recipeError(error);
  return c.json({ errorCode: result.errorCode, message: result.message }, result.status);
});
router.get("/", async (c) => c.json({ recipes: await listRecipes(c.get("user").id) }));
router.post("/", async (c) => {
  const body = await bodyObject(c);
  return c.json({ recipe: await createRecipe(c.get("user").id, body.spec) }, 201);
});
router.get("/:id", async (c) => {
  const detail = await getRecipe(c.get("user").id, c.req.param("id"));
  if (!detail) return c.json({ errorCode: "recipe_not_found" }, 404);
  return c.json(detail);
});
router.put("/:id", async (c) => {
  const body = await bodyObject(c);
  return c.json({
    recipe: await updateRecipe(
      c.get("user").id,
      c.req.param("id"),
      body.spec,
      body.expectedVersion,
    ),
  });
});
router.delete("/:id", async (c) => {
  if (!(await deleteRecipe(c.get("user").id, c.req.param("id"))))
    return c.json({ errorCode: "recipe_not_found" }, 404);
  return c.json({ success: true });
});
router.post("/:id/prepare", async (c) => {
  const body = await bodyObject(c);
  return c.json(
    await prepareRecipe(c.get("user").id, c.req.param("id"), body.version, body.values),
  );
});
router.post("/:id/restore", async (c) => {
  const body = await bodyObject(c);
  return c.json({
    recipe: await restoreRecipe(
      c.get("user").id,
      c.req.param("id"),
      body.sourceVersion,
      body.expectedVersion,
    ),
  });
});
router.post("/:id/schedule", async (c) => {
  const body = await bodyObject(c);
  const task = await scheduleRecipe(
    c.get("user").id,
    c.req.param("id"),
    body.version,
    body.values,
    body.frequency,
    body.time,
    { title: body.title, notifyOnComplete: body.notifyOnComplete, requestId: body.requestId },
  );
  rescheduleScheduler();
  return c.json({ task }, 201);
});
export default router;
