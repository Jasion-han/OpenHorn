import type { Context, MiddlewareHandler } from "hono";
import { db } from "../db";
import { users } from "db";

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

export async function getRequestUser(_c: Context): Promise<RequestUser> {
  const row = await db
    .select()
    .from(users)
    .limit(1)
    .then((r) => r[0]);
  if (!row) return null;
  return { id: row.id, email: row.email, username: row.username };
}

export const requireUser: MiddlewareHandler<UserEnv> = async (c, next) => {
  const user = await getRequestUser(c);
  if (!user) {
    return c.json({ error: "No local user configured" }, 401);
  }
  c.set("user", user);
  return next();
};
