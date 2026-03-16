import { test, expect } from 'bun:test';
import { setSettingValue, getSettingValues, deleteSettingValue } from './settingsService';
import { db } from '../db';
import { users } from 'db';
import { eq } from 'drizzle-orm';

test('settings: set/get/delete value by key', async () => {
  const userId = crypto.randomUUID();
  const key = 'chat.systemPrompt';

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: 'u',
    passwordHash: 'x',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    await setSettingValue(userId, key, 'hello');
    expect(await getSettingValues(userId, [key])).toEqual({ [key]: 'hello' });

    await deleteSettingValue(userId, key);
    expect(await getSettingValues(userId, [key])).toEqual({});
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test('settings: user isolation', async () => {
  const key = 'chat.systemPrompt';
  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();

  await db.insert(users).values([
    {
      id: u1,
      email: `${u1}@test.local`,
      username: 'u1',
      passwordHash: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: u2,
      email: `${u2}@test.local`,
      username: 'u2',
      passwordHash: 'x',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  try {
    await setSettingValue(u1, key, 'u1');
    await setSettingValue(u2, key, 'u2');

    expect(await getSettingValues(u1, [key])).toEqual({ [key]: 'u1' });
    expect(await getSettingValues(u2, [key])).toEqual({ [key]: 'u2' });
  } finally {
    await deleteSettingValue(u1, key);
    await deleteSettingValue(u2, key);
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  }
});
