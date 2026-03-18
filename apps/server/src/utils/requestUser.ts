import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getUserById, verifyToken } from "../services/authService";

export type RequestUser = Awaited<ReturnType<typeof getUserById>>;
export type AuthenticatedUser = NonNullable<RequestUser>;
export type UserEnv = {
  Variables: {
    user: AuthenticatedUser;
  };
};

export async function getRequestUser(c: Context): Promise<RequestUser> {
  const token = getCookie(c, "token");
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return getUserById(payload.userId);
}

export const requireUser: MiddlewareHandler<UserEnv> = async (c, next) => {
  const user = await getRequestUser(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  return next();
};
