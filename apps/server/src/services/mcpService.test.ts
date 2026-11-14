import { expect, test } from "bun:test";
import { mcpServers, users } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import {
  type CreateMCPServerInput,
  createMCPServer,
  deleteMCPServer,
  getMCPServerById,
  getMCPServers,
  type UpdateMCPServerInput,
  updateMCPServer,
} from "./mcpService";

test("MCP service rejects non-object configs before writes and keeps owner checks", async () => {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "config-contract",
    passwordHash: "unused",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    const owned = await createMCPServer(userId, {
      name: "original",
      type: "stdio",
      config: { command: "openhorn-qa-do-not-execute" },
    });
    const original = await db.select().from(mcpServers).where(eq(mcpServers.userId, userId));
    for (const config of [null, [], "scalar", 42, false, undefined]) {
      await expect(
        createMCPServer(userId, {
          name: "invalid",
          type: "stdio",
          config,
        } as unknown as CreateMCPServerInput),
      ).rejects.toMatchObject({ code: "mcp_invalid_config" });
      await expect(
        updateMCPServer(userId, owned.id, {
          name: "must-not-write",
          config,
        } as unknown as UpdateMCPServerInput),
      ).rejects.toMatchObject({ code: "mcp_invalid_config" });
      expect(await db.select().from(mcpServers).where(eq(mcpServers.userId, userId))).toEqual(
        original,
      );
    }
    await expect(
      updateMCPServer("other-user", owned.id, { config: null } as unknown as UpdateMCPServerInput),
    ).rejects.toThrow("MCP Server not found");
    await updateMCPServer(userId, owned.id, { config: {}, isEnabled: false });
    expect(await getMCPServerById(userId, owned.id)).toMatchObject({
      config: {},
      isEnabled: false,
    });
  } finally {
    await db.delete(mcpServers).where(eq(mcpServers.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("mcp: user isolation (account-level)", async () => {
  await bootstrapDatabase();

  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();

  await db.insert(users).values([
    {
      id: u1,
      email: `${u1}@test.local`,
      username: "u1",
      passwordHash: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: u2,
      email: `${u2}@test.local`,
      username: "u2",
      passwordHash: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  try {
    const s1 = await createMCPServer(u1, { name: "srv1", type: "stdio", config: { a: 1 } });
    const s2 = await createMCPServer(u2, { name: "srv2", type: "stdio", config: { b: 2 } });

    const list1 = await getMCPServers(u1);
    const list2 = await getMCPServers(u2);
    expect(list1.map((x) => x.id)).toEqual([s1.id]);
    expect(list2.map((x) => x.id)).toEqual([s2.id]);

    expect(await getMCPServerById(u2, s1.id)).toBeNull();

    // Non-owner delete should not affect the record.
    await expect(deleteMCPServer(u2, s1.id)).rejects.toThrow("MCP Server not found");
    expect(await getMCPServerById(u1, s1.id)).not.toBeNull();
  } finally {
    await db.delete(mcpServers).where(eq(mcpServers.userId, u1));
    await db.delete(mcpServers).where(eq(mcpServers.userId, u2));
    await db.delete(users).where(and(eq(users.id, u1)));
    await db.delete(users).where(and(eq(users.id, u2)));
  }
});
