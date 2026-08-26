import { Hono } from "hono";
import { getRequestUser, type UserEnv } from "../utils/requestUser";

const authRoutes = new Hono<UserEnv>();

authRoutes.get("/me", async (c) => {
  const user = await getRequestUser(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});

export default authRoutes;
