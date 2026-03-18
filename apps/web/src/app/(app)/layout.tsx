import { AppShellLayout } from "../../components/app/AppShellLayout";
import { AuthBootstrap } from "../../components/auth/AuthBootstrap";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthBootstrap>
      <AppShellLayout>{children}</AppShellLayout>
    </AuthBootstrap>
  );
}
