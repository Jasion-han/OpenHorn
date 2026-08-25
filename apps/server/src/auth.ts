import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "db";
import { db } from "./db";
import { sendEmail } from "./email";

const port = parseInt(process.env.PORT || "3002", 10);

function emailTemplate(opts: {
  title: string;
  body: string;
  actionUrl: string;
  actionText: string;
  footer: string;
}) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f9fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="padding:48px 24px">
<tr><td align="center">

<!-- Logo -->
<table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin-bottom:32px">
<tr><td align="center" style="font-size:28px;font-weight:800;letter-spacing:-0.5px;color:#18181b">
<span style="display:inline-block;width:36px;height:36px;background:#18181b;border-radius:8px;color:#fff;font-size:18px;line-height:36px;text-align:center;margin-right:10px;vertical-align:middle">O</span>
<span style="vertical-align:middle">OpenHorn</span>
</td></tr>
</table>

<!-- Card -->
<table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden">

<!-- Title -->
<tr><td style="padding:40px 40px 0;text-align:center;font-size:24px;font-weight:700;color:#111827">${opts.title}</td></tr>

<!-- Body -->
<tr><td style="padding:16px 40px 32px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center">${opts.body}</td></tr>

<!-- Button -->
<tr><td align="center" style="padding:0 40px 36px">
<a href="${opts.actionUrl}" style="display:inline-block;padding:14px 40px;background:#111827;color:#ffffff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:0.2px">${opts.actionText}</a>
</td></tr>

<!-- Divider + Footer -->
<tr><td style="padding:0 40px"><div style="border-top:1px solid #f0f0f0"></div></td></tr>
<tr><td style="padding:20px 40px 32px;font-size:13px;line-height:1.5;color:#9ca3af;text-align:center">${opts.footer}</td></tr>

</table>

<!-- Bottom brand -->
<table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin-top:24px">
<tr><td align="center" style="font-size:12px;color:#9ca3af">Sent by OpenHorn</td></tr>
</table>

</td></tr>
</table>
</body></html>`;
}

export const auth = betterAuth({
  baseURL: `http://localhost:${port}`,
  basePath: "/api/auth",
  database: drizzleAdapter(db, { provider: "sqlite", usePlural: true }),
  trustedOrigins: [
    "tauri://localhost",
    "http://localhost:5173",
    "http://localhost:3002",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3002",
  ],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
    requireEmailVerification: !!process.env.RESEND_API_KEY,
    password: {
      hash: (password) => bcrypt.hash(password, 10),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your OpenHorn password",
        html: emailTemplate({
          title: "Reset your password",
          body: `Hi ${user.name || "there"}, we received a request to reset the password for your OpenHorn account. Click the button below to set a new password. This link expires in 1 hour.`,
          actionUrl: url,
          actionText: "Reset Password",
          footer: "If you didn't request this, you can safely ignore this email.",
        }),
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your OpenHorn email",
        html: emailTemplate({
          title: "Verify your email",
          body: `Hi ${user.name || "there"}, thanks for signing up for OpenHorn! Please verify your email address by clicking the button below.`,
          actionUrl: url,
          actionText: "Verify Email",
          footer: "If you didn't create an account, you can safely ignore this email.",
        }),
      });
    },
  },
  socialProviders:
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined,
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "credential"],
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    enabled: true,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 3 },
    },
  },
  user: {
    fields: { name: "username" },
    additionalFields: {
      tokenVersion: { type: "number", defaultValue: 0, input: false },
    },
  },
});
