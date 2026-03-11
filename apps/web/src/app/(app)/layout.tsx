import { AuthBootstrap } from '../../components/auth/AuthBootstrap';
import { AppShellLayout } from '../../components/app/AppShellLayout';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthBootstrap>
      <AppShellLayout>{children}</AppShellLayout>
    </AuthBootstrap>
  );
}

