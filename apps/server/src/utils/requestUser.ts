import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { getUserFromToken } from "../services/authService";

export type RequestUser = Awaited<ReturnType<typeof getUserFromToken>>;
export type AuthenticatedUser = NonNullable<RequestUser>;
export type UserEnv = {
  Variables: {
    user: AuthenticatedUser;
  };
};

export async function getRequestUser(c: Context): Promise<RequestUser> {
  const token = getCookie(c, "token");
  if (!token) return null;

  return getUserFromToken(token);
}

export const requireUser: MiddlewareHandler<UserEnv> = async (c, next) => {
  const user = await getRequestUser(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  return next();
};
