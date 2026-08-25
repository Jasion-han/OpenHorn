import { useState } from "react";
import { Button, cn, Input, Label } from "ui";
import { authClient } from "../../lib/authClient";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { useAuthStore } from "../../stores/authStore";

import { PENDING_OAUTH_NONCE_KEY } from "../../lib/constants";

const REMEMBERED_EMAIL_KEY = "openhorn:remembered_email";
const REMEMBERED_PASSWORD_KEY = "openhorn:remembered_password";

type AuthView = "login" | "register" | "forgotPassword";

function GoogleIcon() {
  return (
    <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" role="img" aria-label="Google">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function DesktopAuthScreen() {
  const [view, setView] = useState<AuthView>("login");
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? "");
  const [password, setPassword] = useState(
    () => localStorage.getItem(REMEMBERED_PASSWORD_KEY) ?? "",
  );
  const [username, setUsername] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(
    () => localStorage.getItem(REMEMBERED_EMAIL_KEY) !== null,
  );
  const [googleLoading, setGoogleLoading] = useState(false);

  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const loading = useAuthStore((state) => state.loading);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (view === "login" || username.trim().length > 0);

  const handleSubmit = async () => {
    clearError();
    if (view === "login") {
      await login({ email: email.trim(), password, rememberMe });
      if (rememberMe) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
        localStorage.setItem(REMEMBERED_PASSWORD_KEY, password);
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
        localStorage.removeItem(REMEMBERED_PASSWORD_KEY);
      }
      return;
    }
    await register({ email: email.trim(), username: username.trim(), password });
  };

  const handleForgotPassword = async () => {
    setForgotError(null);
    setForgotLoading(true);
    try {
      const { error: err } = await authClient.requestPasswordReset({
        email: forgotEmail.trim(),
        redirectTo: "/",
      });
      if (err) throw err;
      setForgotSent(true);
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? (err as { message: string }).message
          : "Failed to send reset email";
      setForgotError(msg);
    } finally {
      setForgotLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    const nonce = crypto.randomUUID();
    const base = getDesktopBackendBase();

    localStorage.setItem(PENDING_OAUTH_NONCE_KEY, nonce);

    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(`${base}/auth/desktop-google-start?nonce=${nonce}`);
    } catch {
      window.open(`${base}/auth/desktop-google-start?nonce=${nonce}`, "_blank");
    }
  };

  if (view === "forgotPassword") {
    return (
      <div className="flex h-dvh flex-col bg-gradient-to-br from-background via-background to-muted/20 px-4">
        <div data-tauri-drag-region className="shrink-0" style={{ height: "24px" }} />
        <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold">Reset Password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {forgotSent
                ? "Check your email for a reset link."
                : "Enter your email to receive a password reset link."}
            </p>
          </div>

          <div className="rounded-2xl border border-border/50 bg-card p-6 shadow-minimal">
            {forgotSent ? (
              <div className="flex flex-col gap-3">
                <p className="text-center text-sm text-muted-foreground">
                  If an account exists with that email, you will receive a reset link shortly.
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setView("login");
                    setForgotSent(false);
                    setForgotEmail("");
                    setForgotError(null);
                  }}
                >
                  Back to Login
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="desktop-forgot-email">Email</Label>
                  <Input
                    id="desktop-forgot-email"
                    type="email"
                    placeholder="your@email.com"
                    value={forgotEmail}
                    onChange={(event) => setForgotEmail(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && forgotEmail.trim() && !forgotLoading) {
                        void handleForgotPassword();
                      }
                    }}
                  />
                </div>

                <Button
                  className="mt-1 w-full"
                  disabled={!forgotEmail.trim() || forgotLoading}
                  onClick={() => void handleForgotPassword()}
                >
                  {forgotLoading ? "Sending..." : "Send Reset Link"}
                </Button>

                {forgotError && (
                  <p className="text-center text-sm text-destructive">{forgotError}</p>
                )}

                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setView("login");
                    setForgotError(null);
                  }}
                >
                  Back to Login
                </button>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-gradient-to-br from-background via-background to-muted/20 px-4">
      <div data-tauri-drag-region className="shrink-0" style={{ height: "24px" }} />
      <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">Welcome to OpenHorn</h1>
          <p className="mt-1 text-sm text-muted-foreground">AI Assistant</p>
        </div>

        <div className="rounded-2xl border border-border/50 bg-card p-6 shadow-minimal">
          <div className="mb-4 flex gap-1 rounded-lg bg-muted/60 p-1">
            {(["login", "register"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  clearError();
                  setView(tab);
                }}
                className={cn(
                  "flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
                  view === tab
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === "login" ? "Login" : "Register"}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {view === "register" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="desktop-auth-username">Username</Label>
                <Input
                  id="desktop-auth-username"
                  placeholder="Your username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="desktop-auth-email">Email</Label>
              <Input
                id="desktop-auth-email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="desktop-auth-password">Password</Label>
              <Input
                id="desktop-auth-password"
                type="password"
                placeholder="Your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSubmit && !loading) {
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {view === "login" && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded"
                  />
                  Remember me
                </label>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    clearError();
                    setView("forgotPassword");
                  }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <Button
              className="mt-1 w-full"
              disabled={!canSubmit || loading}
              onClick={() => void handleSubmit()}
            >
              {loading ? "Loading..." : view === "login" ? "Login" : "Register"}
            </Button>
          </div>

          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border/50" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full"
            disabled={googleLoading}
            onClick={() => void handleGoogleLogin()}
          >
            <GoogleIcon />
            {googleLoading ? "Redirecting..." : "Continue with Google"}
          </Button>

          {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}
        </div>
      </div>
      </div>
    </div>
  );
}
