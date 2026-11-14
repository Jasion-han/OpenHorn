import { createHash } from "node:crypto";
import type { messages } from "db";

type MessageRow = typeof messages.$inferSelect;

/** Hash only stored fields, in a fixed order; never hash API/UI decorations. */
export function messageSaveToken(row: MessageRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.conversationId,
        row.role,
        row.content,
        row.model ?? null,
        row.mode ?? null,
        row.attachments ?? null,
        row.agentRun ?? null,
        row.workspaceId ?? null,
        row.contextPaths ?? null,
        row.liveMetadata ?? null,
        row.citations ?? null,
        row.usage ?? null,
        row.finishReason ?? null,
        row.createdAt.getTime(),
        row.updatedAt?.getTime() ?? null,
        // Preserve legacy tokens for rows without provider state so an app
        // update does not invalidate unrelated pending Agent saves.
        ...(row.providerState ? [["provider_state", row.providerState]] : []),
        ...(row.completionVersion ? [["completion_version", row.completionVersion]] : []),
      ]),
    )
    .digest("hex");
}

export class SidecarSaveConflictError extends Error {
  readonly code = "sidecar_save_conflict";
  constructor() {
    super("The saved message changed after this local result was prepared");
    this.name = "SidecarSaveConflictError";
  }
}
