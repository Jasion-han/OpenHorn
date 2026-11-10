import { Hono } from "hono";
import { unifiedSearch } from "../services/unifiedSearchService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();
router.use("*", requireUser);
router.get("/", async (c) => {
  const query = c.req.query("q") ?? "";
  if (query.trim().length > 200) return c.json({ errorCode: "search_query_limit" }, 400);
  return c.json({ results: await unifiedSearch(c.get("user").id, query) });
});
export default router;
