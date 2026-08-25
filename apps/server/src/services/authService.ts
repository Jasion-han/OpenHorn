import { users } from "db";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";

export interface PublicUser {
  id: string;
  email: string;
  username: string;
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (result.length === 0) return null;
  const user = result[0];
  return { id: user.id, email: user.email, username: user.username };
}

export async function revokeUserSessions(userId: string): Promise<boolean> {
  const result = await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return result.length > 0;
}
