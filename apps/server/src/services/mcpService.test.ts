import { test, expect } from 'bun:test';
import { db } from '../db';
import { mcpServers, users } from 'db';
import { and, eq } from 'drizzle-orm';
import { bootstrapDatabase } from '../db/bootstrap';
import { createMCPServer, deleteMCPServer, getMCPServerById, getMCPServers } from './mcpService';

test('mcp: user isolation (account-level)', async () => {
  await bootstrapDatabase();

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
    const s1 = await createMCPServer(u1, { name: 'srv1', type: 'stdio', config: { a: 1 } });
    const s2 = await createMCPServer(u2, { name: 'srv2', type: 'stdio', config: { b: 2 } });

    const list1 = await getMCPServers(u1);
    const list2 = await getMCPServers(u2);
    expect(list1.map((x) => x.id)).toEqual([s1.id]);
    expect(list2.map((x) => x.id)).toEqual([s2.id]);

    expect(await getMCPServerById(u2, s1.id)).toBeNull();

    // Non-owner delete should not affect the record.
    await expect(deleteMCPServer(u2, s1.id)).rejects.toThrow('MCP Server not found');
    expect(await getMCPServerById(u1, s1.id)).not.toBeNull();
  } finally {
    await db.delete(mcpServers).where(eq(mcpServers.userId, u1));
    await db.delete(mcpServers).where(eq(mcpServers.userId, u2));
    await db.delete(users).where(and(eq(users.id, u1)));
    await db.delete(users).where(and(eq(users.id, u2)));
  }
});
