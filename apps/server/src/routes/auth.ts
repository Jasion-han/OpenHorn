import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getUserFromToken, login, register, revokeUserSessions } from "../services/authService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const auth = new Hono<UserEnv>();

auth.post("/register", async (c) => {
  try {
    const body = await c.req.json();
    const result = await register(body);

    setCookie(c, "token", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
    });

    return c.json({ user: result.user });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Registration failed",
      },
      400,
    );
  }
});

auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const result = await login(body);

    setCookie(c, "token", result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
    });

    return c.json({ user: result.user });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Login failed",
      },
      401,
    );
  }
});

auth.post("/logout", async (c) => {
  setCookie(c, "token", "", {
    httpOnly: true,
    maxAge: 0,
  });

  return c.json({ success: true });
});

// Revokes every active session for the authenticated user (e.g. after a leaked
// cookie) by bumping the server-side token version, then clears the local
// cookie. All other outstanding JWTs stop verifying immediately.
auth.post("/logout-all", requireUser, async (c) => {
  const user = c.get("user");
  await revokeUserSessions(user.id);

  setCookie(c, "token", "", {
    httpOnly: true,
    maxAge: 0,
  });

  return c.json({ success: true });
});

auth.get("/me", async (c) => {
  const token = getCookie(c, "token");

  if (!token) {
    return c.json({ user: null });
  }

  const user = await getUserFromToken(token);

  return c.json({ user });
});

export default auth;
