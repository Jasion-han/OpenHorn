import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { auth } from "../auth";
import { client } from "../db";
import { requireUser, type UserEnv } from "../utils/requestUser";

const authRoutes = new Hono<UserEnv>();

authRoutes.get("/me", async (c) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) return c.json({ user: null });
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      username: session.user.name,
    },
  });
});

authRoutes.post("/logout-all", requireUser, async (c) => {
  await auth.api.revokeSessions({
    headers: c.req.raw.headers,
  });
  return c.json({ success: true });
});

authRoutes.get("/desktop-google-start", async (c) => {
  const nonce = c.req.query("nonce");
  if (!nonce) return c.text("Missing nonce", 400);

  const callbackURL = `/auth/desktop-oauth-callback?nonce=${encodeURIComponent(nonce)}`;
  const port = parseInt(process.env.PORT || "3002", 10);

  const res = await fetch(`http://localhost:${port}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL }),
    redirect: "manual",
  });

  for (const cookie of res.headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }

  const data = (await res.json()) as { url?: string };
  if (data.url) return c.redirect(data.url);

  return c.text("Failed to start OAuth", 500);
});

authRoutes.get("/desktop-oauth-callback", async (c) => {
  const nonce = c.req.query("nonce");
  if (!nonce) return c.text("Missing nonce", 400);

  const sessionToken = getCookie(c, "better-auth.session_token");
  if (!sessionToken) return c.text("No session found", 401);

  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  await client.execute({
    sql: `INSERT OR REPLACE INTO verification (id, identifier, value, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      `desktop-oauth-${nonce}`,
      `desktop-oauth:${nonce}`,
      sessionToken,
      expiresAt,
      Math.floor(Date.now() / 1000),
      Math.floor(Date.now() / 1000),
    ],
  });

  return c.html(`<!DOCTYPE html>
<html><head><title>Login Successful</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui">
<div style="text-align:center">
<h2 style="color:#22c55e">Login successful</h2>
<p style="color:#666">You can close this tab and return to OpenHorn.</p>
</div></body></html>`);
});

authRoutes.get("/desktop-oauth-exchange", async (c) => {
  const nonce = c.req.query("nonce");
  if (!nonce) return c.json({ error: "Missing nonce" }, 400);

  const now = Math.floor(Date.now() / 1000);
  await client.execute({
    sql: `DELETE FROM verification WHERE identifier LIKE 'desktop-oauth:%' AND expires_at < ?`,
    args: [now],
  });

  const result = await client.execute({
    sql: `SELECT value FROM verification WHERE id = ? AND expires_at >= ?`,
    args: [`desktop-oauth-${nonce}`, now],
  });

  if (!result.rows.length) return c.json({ status: "pending" }, 202);

  const sessionToken = result.rows[0].value as string;

  await client.execute({
    sql: `DELETE FROM verification WHERE id = ?`,
    args: [`desktop-oauth-${nonce}`],
  });

  c.header(
    "Set-Cookie",
    `better-auth.session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`,
  );

  return c.json({ status: "ok" });
});

export default authRoutes;
