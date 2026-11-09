import { expect, test } from "bun:test";
import { settings, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  getJevStatus,
  JEV_REQUEST_RESERVE_USD,
  reserveJevRequest,
  settleJevRequest,
} from "./decisionUsageService";

test("daily decision reservations persist, prevent overspend and settle each receipt once", async () => {
  const id = crypto.randomUUID(),
    previous = process.env.OPENHORN_JEV_DAILY_BUDGET_USD;
  process.env.OPENHORN_JEV_DAILY_BUDGET_USD = String(JEV_REQUEST_RESERVE_USD * 1.5);
  await db.insert(users).values({
    id,
    email: `${id}@test.local`,
    username: "synthetic",
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    const first = await reserveJevRequest(id);
    expect(Boolean(first)).toBe(true);
    expect(await reserveJevRequest(id)).toBeNull();
    expect((await getJevStatus(id)).reservedUsd).toBe(JEV_REQUEST_RESERVE_USD);
    if (!first) throw new Error("Expected reservation");
    await settleJevRequest(id, first, 0.0001);
    await settleJevRequest(id, first, 0.0001);
    expect((await getJevStatus(id)).spentUsd).toBe(0.0001);
    expect((await getJevStatus(id)).reservedUsd).toBe(0);
    const second = await reserveJevRequest(id);
    expect(Boolean(second)).toBe(true);
    if (!second) throw new Error("Expected second reservation");
    await settleJevRequest(id, second, 0.01);
    expect((await getJevStatus(id)).spentUsd).toBe(0.0001 + 0.01);
    expect(await reserveJevRequest(id)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.OPENHORN_JEV_DAILY_BUDGET_USD;
    else process.env.OPENHORN_JEV_DAILY_BUDGET_USD = previous;
    await db.delete(settings).where(eq(settings.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});
