import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "db";
import { db } from "./db";
import { sendEmail } from "./email";

const port = parseInt(process.env.PORT || "3002", 10);

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
        subject: "Reset your password",
        html: `<a href="${url}">Reset password</a>`,
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Verify your email",
        html: `<a href="${url}">Verify email</a>`,
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
