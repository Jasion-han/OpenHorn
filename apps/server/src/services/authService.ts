import bcrypt from "bcryptjs";
import { users } from "db";
import { eq, sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { db } from "../db";
import { generateId } from "../utils";

/**
 * Resolves the JWT signing secret. Fails fast when `JWT_SECRET` is missing
 * instead of silently falling back to a publicly-known default (which would
 * let anyone forge tokens for any user). Mirrors the `ENCRYPTION_KEY` handling
 * in `utils.ts`. Lazy so importing this module never throws — only signing /
 * verifying a token requires the secret.
 */
function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

/** Public user shape returned to callers — never includes credential fields. */
export interface PublicUser {
  id: string;
  email: string;
  username: string;
}

/**
 * Signs a session JWT that embeds the user's current `tokenVersion`. When the
 * user later revokes their sessions, `tokenVersion` is bumped and this token
 * stops verifying (see `getUserFromToken`).
 */
function signSessionToken(userId: string, tokenVersion: number): Promise<string> {
  return new SignJWT({ userId, tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());
}

export async function register(input: RegisterInput) {
  const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  // Use a neutral, non-enumerable error instead of confirming the address is
  // already taken. The DB unique constraint still prevents duplicate accounts;
  // this only avoids leaking account existence via the API error message.
  if (existing.length > 0) {
    throw new Error("Unable to register with the provided details");
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const id = generateId();
  const now = new Date();

  await db.insert(users).values({
    id,
    email: input.email,
    username: input.username,
    passwordHash,
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });

  const token = await signSessionToken(id, 0);

  return { token, user: { id, email: input.email, username: input.username } };
}

export async function login(input: LoginInput) {
  const result = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (result.length === 0) {
    throw new Error("Invalid email or password");
  }

  const user = result[0];
  const valid = await bcrypt.compare(input.password, user.passwordHash);

  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const token = await signSessionToken(user.id, user.tokenVersion);

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  };
}

export async function verifyToken(token: string) {
  // Resolve the secret outside the try so a missing-config error surfaces
  // (fail-fast) instead of being swallowed as an "invalid token".
  const secret = getJwtSecret();
  try {
    const { payload } = await jwtVerify(token, secret);
    // `tokenVersion` is optional so pre-migration tokens (issued before the
    // field existed) still decode; they are treated as version 0 downstream.
    return payload as { userId: string; tokenVersion?: number };
  } catch {
    return null;
  }
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (result.length === 0) return null;

  const user = result[0];
  return {
    id: user.id,
    email: user.email,
    username: user.username,
  };
}

/**
 * Verifies a session token and resolves the owning user, rejecting tokens whose
 * embedded `tokenVersion` no longer matches the stored value (i.e. the user has
 * revoked their sessions). The single user lookup here replaces the one that
 * `getUserById` would have performed, so request auth costs no extra query.
 * A token without `tokenVersion` (issued before this field existed) is treated
 * as version 0, matching the default on existing rows — so deploying this change
 * does not invalidate currently-active sessions.
 */
export async function getUserFromToken(token: string): Promise<PublicUser | null> {
  const payload = await verifyToken(token);
  if (!payload) return null;

  const result = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
  if (result.length === 0) return null;

  const user = result[0];
  if ((payload.tokenVersion ?? 0) !== user.tokenVersion) return null;

  return {
    id: user.id,
    email: user.email,
    username: user.username,
  };
}

/**
 * Revokes every outstanding session for a user by bumping `tokenVersion`.
 * Returns false when the user no longer exists.
 */
export async function revokeUserSessions(userId: string): Promise<boolean> {
  const result = await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  return result.length > 0;
}
