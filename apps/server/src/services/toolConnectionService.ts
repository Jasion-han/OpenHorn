import { createHash } from "node:crypto";
import { channels } from "db";
import { and, eq } from "drizzle-orm";
import {
  normalizeToolBaseUrl,
  parseToolConnectionConfig,
  type ToolConnection,
  toolBaseUrl,
} from "shared/tool-connection";
import { db } from "../db";
import { decrypt } from "../utils";

export const toolConnectionFingerprint = (connection: ToolConnection) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: connection.kind,
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        model: connection.model ?? "",
      }),
    )
    .digest("hex");

/** A configured but unavailable connection never borrows the old official credential. */
export async function resolveToolConnection(
  userId: string,
  raw: string | undefined,
  legacyKey: string | undefined,
  database: Pick<typeof db, "select"> = db,
): Promise<ToolConnection | undefined> {
  if (raw === undefined)
    return legacyKey?.trim()
      ? { kind: "deepseek", baseUrl: toolBaseUrl("deepseek"), apiKey: legacyKey.trim() }
      : undefined;
  try {
    const config = parseToolConnectionConfig(raw);
    if (config.source === "manual") return config.apiKey ? config : undefined;
    const [row] = await database
      .select()
      .from(channels)
      .where(and(eq(channels.id, config.channelId), eq(channels.userId, userId)));
    if (!row || !row.enabled || row.protocol !== "openai" || !row.apiKey || !row.baseUrl)
      return undefined;
    const apiKey = decrypt(row.apiKey);
    if (!apiKey.trim() || apiKey.startsWith("__cli_oauth__:")) return undefined;
    return {
      kind: config.kind,
      baseUrl: normalizeToolBaseUrl(row.baseUrl),
      apiKey,
      ...(config.model ? { model: config.model } : {}),
    };
  } catch {
    return undefined;
  }
}
