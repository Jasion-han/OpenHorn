import { expect, test } from "bun:test";
import { users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { getUserById, revokeUserSessions } from "./authService";

test("auth: revokeUserSessions bumps tokenVersion", async () => {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id,
    email: `${id}@revocation.test`,
    username: "revoke",
    passwordHash: "not-used",
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const before = await getUserById(id);
    expect(before).toMatchObject({ id, email: `${id}@revocation.test` });

    const revoked = await revokeUserSessions(id);
    expect(revoked).toBe(true);

    const row = await db.select().from(users).where(eq(users.id, id)).limit(1);
    expect(row[0].tokenVersion).toBe(1);
  } finally {
    await db.delete(users).where(eq(users.id, id));
  }
});
