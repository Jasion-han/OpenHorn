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
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:40px;max-width:480px">
<tr><td style="text-align:center;padding-bottom:24px;font-size:22px;font-weight:700;color:#18181b">${opts.title}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#3f3f46;padding-bottom:28px">${opts.body}</td></tr>
<tr><td align="center" style="padding-bottom:28px">
<a href="${opts.actionUrl}" style="display:inline-block;padding:12px 32px;background:#18181b;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600">${opts.actionText}</a>
</td></tr>
<tr><td style="font-size:13px;color:#a1a1aa;border-top:1px solid #e4e4e7;padding-top:20px">${opts.footer}</td></tr>
<tr><td style="font-size:12px;color:#a1a1aa;padding-top:16px;text-align:center">OpenHorn</td></tr>
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
