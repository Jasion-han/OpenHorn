import { useState } from "react";
import { Button, cn, Input, Label } from "ui";
import { useAuthStore } from "../../stores/authStore";

type AuthTab = "login" | "register";

export function DesktopAuthScreen() {
  const [activeTab, setActiveTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");

  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const loading = useAuthStore((state) => state.loading);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (activeTab === "login" || username.trim().length > 0);

  const handleSubmit = async () => {
    clearError();
    if (activeTab === "login") {
      await login({
        email: email.trim(),
        password,
      });
      return;
    }

    await register({
      email: email.trim(),
      username: username.trim(),
      password,
    });
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 px-4">
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
                  setActiveTab(tab);
                }}
                className={cn(
                  "flex-1 rounded-md py-1.5 text-sm font-medium transition-colors",
                  activeTab === tab
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === "login" ? "Login" : "Register"}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {activeTab === "register" && (
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

            <Button
              className="mt-1 w-full"
              disabled={!canSubmit || loading}
              onClick={() => void handleSubmit()}
            >
              {loading ? "Loading..." : activeTab === "login" ? "Login" : "Register"}
            </Button>
          </div>

          {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
