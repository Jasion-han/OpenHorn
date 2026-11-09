import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { decisionEnhancements, routeShadowStats } from "../services/decisionEnhancements";
import { getJevStatus, saveJevPreferences } from "../services/decisionUsageService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();
router.use("*", requireUser);
router.use(
  "*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ errorCode: "decision_input_limit" }, 413),
  }),
);
router.get("/status", async (c) =>
  c.json({ ...(await getJevStatus(c.get("user").id)), shadow: routeShadowStats(c.get("user").id) }),
);
router.put("/config", async (c) => {
  try {
    await saveJevPreferences(c.get("user").id, await c.req.json());
    return c.json(await getJevStatus(c.get("user").id));
  } catch {
    return c.json({ errorCode: "decision_invalid_input" }, 400);
  }
});
router.post("/skills", async (c) => {
  try {
    const body = await c.req.json();
    if (
      !body ||
      typeof body.prompt !== "string" ||
      body.prompt.length > 8000 ||
      !Array.isArray(body.skills) ||
      body.skills.length > 60 ||
      body.skills.some(
        (skill: { name?: unknown; description?: unknown }) =>
          !skill ||
          typeof skill.name !== "string" ||
          !skill.name.trim() ||
          skill.name.length > 150 ||
          typeof skill.description !== "string" ||
          skill.description.length > 800,
      ) ||
      new Set(body.skills.map((skill: { name: string }) => skill.name)).size !== body.skills.length
    )
      return c.json({ errorCode: "decision_invalid_input" }, 400);
    const skills = body.skills.map((skill: { name: string; description: string }) => ({
      name: skill.name,
      description: skill.description,
    }));
    return c.json(await decisionEnhancements.suggestSkill(c.get("user").id, body.prompt, skills));
  } catch {
    return c.json({ preferredNames: [], reason: "unavailable" });
  }
});
export default router;
