import { Hono } from "hono";
import { auth } from "../auth";
import { requireUser, type UserEnv } from "../utils/requestUser";

const authRoutes = new Hono<UserEnv>();

authRoutes.get("/me", async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ user: null });
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      username: session.user.name,
    },
  });
});

authRoutes.post("/logout-all", requireUser, async (c) => {
  await auth.api.revokeSessions({
    headers: c.req.raw.headers,
  });
  return c.json({ success: true });
});

export default authRoutes;
