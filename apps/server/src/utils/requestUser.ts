import type { Context, MiddlewareHandler } from "hono";
import { auth } from "../auth";

export interface PublicUser {
  id: string;
  email: string;
  username: string;
}

export type RequestUser = PublicUser | null;
export type AuthenticatedUser = NonNullable<RequestUser>;
export type UserEnv = {
  Variables: {
    user: AuthenticatedUser;
  };
};

export async function getRequestUser(c: Context): Promise<RequestUser> {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    username: session.user.name,
  };
}

export const requireUser: MiddlewareHandler<UserEnv> = async (c, next) => {
  const user = await getRequestUser(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  return next();
};
