'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const { setUser } = useAuthStore();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const { user } = await api.auth.me();
        if (user) {
          setUser(user);
          router.replace('/chat');
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    void run();
    return () => { cancelled = true; };
  }, [router, setUser]);

  if (checking) {
    return (
      <div className="flex h-dvh items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const { user } = await api.auth.login({ email, password });
      setUser(user);
      router.push('/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setLoading(true);
    setError('');
    try {
      const { user } = await api.auth.register({ email, username, password });
      setUser(user);
      router.push('/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
      <div className="w-full max-w-sm px-4">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">Welcome to OpenHorn</h1>
          <p className="mt-1 text-sm text-muted-foreground">AI Assistant</p>
        </div>

        <div className="rounded-2xl border border-border/50 bg-card p-6 shadow-minimal">
          <div className="mb-4 flex gap-1 rounded-lg bg-muted/60 p-1">
            {(['login', 'register'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab === 'login' ? 'Login' : 'Register'}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {activeTab === 'register' && (
              <div className="flex flex-col gap-1.5">
                <Label>Username</Label>
                <Input placeholder="Your username" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>Email</Label>
              <Input type="email" placeholder="your@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Password</Label>
              <Input type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button
              className="w-full mt-1"
              onClick={() => void (activeTab === 'login' ? handleLogin() : handleRegister())}
              disabled={loading}
            >
              {loading ? 'Loading...' : (activeTab === 'login' ? 'Login' : 'Register')}
            </Button>
          </div>

          {error && (
            <p className="mt-3 text-center text-sm text-destructive">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
