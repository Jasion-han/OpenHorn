import { test, expect } from 'bun:test';
import { db } from '../db';
import { channels, users } from 'db';
import { and, eq } from 'drizzle-orm';
import { encrypt } from '../utils';
import { getChannelRuntimeCredentialsById } from './channelService';

test('agent-check: runtime=anthropic baseUrl normalization tolerates mixed suffixes', async () => {
  const userId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: 'u',
    passwordHash: 'x',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(channels).values({
    id: channelId,
    userId,
    name: 'c',
    provider: 'openai',
    apiKey: encrypt('k'),
    // Simulate a relay URL that got normalized weirdly (e.g. /v1/messages/v1).
    baseUrl: 'https://relay.example.com/v1/messages/v1',
    model: null,
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const resolved = await getChannelRuntimeCredentialsById(userId, channelId, { runtime: 'anthropic' });
    expect(resolved.channel.baseUrl).toBe('https://relay.example.com');
  } finally {
    await db.delete(channels).where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
    await db.delete(users).where(eq(users.id, userId));
  }
});

