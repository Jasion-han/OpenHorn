import { useState } from "react";
import { Button, Input, Label, cn } from "ui";
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
    <div className="flex h-dvh w-dvw items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 px-4">
      <div className="w-full max-w-[420px] rounded-[28px] border border-border/60 bg-background/85 p-7 shadow-minimal backdrop-blur-sm">
        <div className="text-center">
          <div className="text-2xl font-semibold tracking-tight">登录 OpenHorn</div>
          <p className="mt-2 text-sm text-muted-foreground">
            登录后即可继续查看历史会话，并在聊天与 Agent 模式之间切换。
          </p>
        </div>

        <div className="mt-6 flex gap-1 rounded-xl bg-muted/60 p-1">
          {(["login", "register"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                clearError();
                setActiveTab(tab);
              }}
              className={cn(
                "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {activeTab === "register" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="desktop-auth-username">用户名</Label>
              <Input
                id="desktop-auth-username"
                placeholder="输入用户名"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="desktop-auth-email">邮箱</Label>
            <Input
              id="desktop-auth-email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="desktop-auth-password">密码</Label>
            <Input
              id="desktop-auth-password"
              type="password"
              placeholder="输入密码"
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
            {loading ? "处理中..." : activeTab === "login" ? "登录" : "注册并进入"}
          </Button>
        </div>

        {error && <div className="mt-4 text-center text-sm text-destructive">{error}</div>}
      </div>
    </div>
  );
}
