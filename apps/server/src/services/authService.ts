import bcrypt from "bcryptjs";
import { users } from "db";
import { eq } from "drizzle-orm";
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

export async function register(input: RegisterInput) {
  const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (existing.length > 0) {
    throw new Error("Email already registered");
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const id = generateId();
  const now = new Date();

  await db.insert(users).values({
    id,
    email: input.email,
    username: input.username,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  const token = await new SignJWT({ userId: id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());

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

  const token = await new SignJWT({ userId: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtSecret());

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
    return payload as { userId: string };
  } catch {
    return null;
  }
}

export async function getUserById(userId: string) {
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (result.length === 0) return null;

  const user = result[0];
  return {
    id: user.id,
    email: user.email,
    username: user.username,
  };
}
