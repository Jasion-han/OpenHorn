'use client';

import { useState } from 'react';
import { TextInput, Button, Stack, Text, Card, Group, Avatar } from '@mantine/core';
import { useAuthStore } from '../../stores/authStore';

export function GeneralSettings() {
  const { user } = useAuthStore();
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');

  return (
    <Stack gap="md">
      <Card withBorder>
        <Group>
          <Avatar size="xl" radius="xl">
            {username?.charAt(0).toUpperCase() || 'U'}
          </Avatar>
          <div>
            <Text fw={500}>{username}</Text>
            <Text size="sm" c="dimmed">{email}</Text>
          </div>
        </Group>
      </Card>

      <TextInput
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />

      <TextInput
        label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled
      />

      <Button w={{ base: '100%', sm: 'auto' }}>Save Changes</Button>
    </Stack>
  );
}
