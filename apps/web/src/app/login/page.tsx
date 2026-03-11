'use client';

import { useEffect, useState } from 'react';
import { Container, Paper, TextInput, PasswordInput, Button, Stack, Title, Text, Tabs, Loader, Center } from '@mantine/core';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../lib/api';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const { setUser } = useAuthStore();
  const router = useRouter();
  
  const [activeTab, setActiveTab] = useState<string | null>('login');
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
        if (!cancelled) {
          setChecking(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [router, setUser]);

  if (checking) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
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
    <Container size={420} my={80}>
      <Title ta="center">Welcome to OpenHorn</Title>
      <Text c="dimmed" size="sm" ta="center" mt={5}>
        AI Assistant
      </Text>

      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List grow>
            <Tabs.Tab value="login">Login</Tabs.Tab>
            <Tabs.Tab value="register">Register</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="login" pt="md">
            <Stack>
              <TextInput
                label="Email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <PasswordInput
                label="Password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button onClick={handleLogin} loading={loading} fullWidth>
                Login
              </Button>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="register" pt="md">
            <Stack>
              <TextInput
                label="Username"
                placeholder="Your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <TextInput
                label="Email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <PasswordInput
                label="Password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button onClick={handleRegister} loading={loading} fullWidth>
                Register
              </Button>
            </Stack>
          </Tabs.Panel>
        </Tabs>

        {error && (
          <Text c="red" size="sm" mt="md" ta="center">
            {error}
          </Text>
        )}
      </Paper>
    </Container>
  );
}
