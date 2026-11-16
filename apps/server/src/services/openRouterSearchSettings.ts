import { createHash } from "node:crypto";
import { settings } from "db";
import { and, eq } from "drizzle-orm";
import {
  OPENROUTER_SEARCH_CONFIG,
  type OpenRouterSearchConnection,
  parseOpenRouterSearchConfig,
} from "shared/openrouter-search";
import { encrypt, generateId } from "../utils";
import { withSearchSettingsTransaction } from "./searchSettingsTransaction";

export function resolveOpenRouterSearchConnection(
  raw: string | undefined,
): OpenRouterSearchConnection | undefined {
  try {
    return raw === undefined ? undefined : parseOpenRouterSearchConfig(raw);
  } catch {
    return undefined;
  }
}
export const openRouterSearchFingerprint = (connection: OpenRouterSearchConnection | undefined) =>
  connection
    ? createHash("sha256")
        .update(JSON.stringify({ provider: "openrouter", ...connection }))
        .digest("hex")
    : undefined;

/** A dedicated encrypted candidate; saving never activates or reads a Jev credential. */
export async function saveOpenRouterSearchConfig(
  userId: string,
  raw: string | null,
): Promise<void> {
  const config = raw === null ? null : parseOpenRouterSearchConfig(raw);
  await withSearchSettingsTransaction(async (tx) => {
    if (config === null) {
      await tx
        .delete(settings)
        .where(and(eq(settings.userId, userId), eq(settings.key, OPENROUTER_SEARCH_CONFIG)));
      return;
    }
    const value = encrypt(JSON.stringify(config)),
      now = new Date();
    await tx
      .insert(settings)
      .values({ id: generateId(), userId, key: OPENROUTER_SEARCH_CONFIG, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value, updatedAt: now },
      });
  });
}
