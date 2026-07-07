import { expect, test } from "bun:test";
import { users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { getUserFromToken, login, register, revokeUserSessions } from "./authService";

test("auth: token stops verifying after sessions are revoked", async () => {
  const email = `${crypto.randomUUID()}@revocation.test`;
  const { token, user } = await register({ email, username: "revoke", password: "secret123" });

  try {
    // A freshly-issued token resolves to its owner.
    const before = await getUserFromToken(token);
    expect(before).toMatchObject({ id: user.id, email });

    // Bumping tokenVersion invalidates every outstanding token immediately.
    const revoked = await revokeUserSessions(user.id);
    expect(revoked).toBe(true);

    const after = await getUserFromToken(token);
    expect(after).toEqual(null);

    // Logging in again mints a token carrying the new version, which verifies.
    const fresh = await login({ email, password: "secret123" });
    const reauth = await getUserFromToken(fresh.token);
    expect(reauth).toMatchObject({ id: user.id, email });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});
