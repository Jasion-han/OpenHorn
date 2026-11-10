import { conversations, messages, projects, savedArtifacts, savedArtifactVersions } from "db";
import { and, asc, desc, eq } from "drizzle-orm";
import { assistantMessageContent } from "shared/message-text";
import type {
  ArtifactDetail,
  ArtifactFormat,
  ArtifactMutationResult,
  ArtifactVersion,
  ArtifactVersionInfo,
  SavedArtifact,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";

export const MAX_ARTIFACT_CONTENT_BYTES = 2 * 1024 * 1024;
type ArtifactErrorCode =
  | "artifact_not_found"
  | "invalid_artifact"
  | "artifact_version_conflict"
  | "source_not_found"
  | "source_not_ready"
  | "project_not_found";

export class ArtifactServiceError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = "ArtifactServiceError";
  }
}

type Reader = Pick<typeof db, "select">;
type ArtifactRow = typeof savedArtifacts.$inferSelect;
type VersionRow = typeof savedArtifactVersions.$inferSelect;

function invalid(): never {
  throw new ArtifactServiceError("invalid_artifact", 400);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 200) {
    return invalid();
  }
  return value.trim();
}

function format(value: unknown): ArtifactFormat {
  if (value === undefined) return "markdown";
  if (value !== "markdown" && value !== "html" && value !== "openui") return invalid();
  return value;
}

function validateContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_ARTIFACT_CONTENT_BYTES
  ) {
    return invalid();
  }
  return value;
}

function toArtifact(row: ArtifactRow): SavedArtifact {
  return {
    id: row.id,
    title: row.title,
    projectId: row.projectId,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersion(row: VersionRow): ArtifactVersion {
  return {
    artifactId: row.artifactId,
    version: row.version,
    content: row.content,
    format: row.format,
    sourceConversationId: row.sourceConversationId,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownedArtifact(reader: Reader, userId: string, artifactId: string) {
  const [row] = await reader
    .select()
    .from(savedArtifacts)
    .where(and(eq(savedArtifacts.id, artifactId), eq(savedArtifacts.userId, userId)))
    .limit(1);
  if (!row) throw new ArtifactServiceError("artifact_not_found", 404);
  return row;
}

async function ownedProject(reader: Reader, userId: string, projectId: unknown) {
  if (projectId === null || projectId === undefined) return null;
  if (typeof projectId !== "string" || !projectId) return invalid();
  const [project] = await reader
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) throw new ArtifactServiceError("project_not_found", 404);
  return project.id;
}

async function resolveContent(reader: Reader, userId: string, input: Record<string, unknown>) {
  const outputFormat = format(input.format);
  if (input.content !== undefined && typeof input.content !== "string") return invalid();
  if (input.sourceMessageId === undefined) {
    return {
      content: validateContent(input.content),
      format: outputFormat,
      sourceConversationId: null,
      sourceMessageId: null,
      sourceTitle: null,
      sourceProjectId: null,
    };
  }
  if (typeof input.sourceMessageId !== "string" || !input.sourceMessageId) return invalid();
  const [source] = await reader
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.id, input.sourceMessageId),
        eq(messages.role, "assistant"),
        eq(conversations.userId, userId),
      ),
    )
    .limit(1);
  if (!source) throw new ArtifactServiceError("source_not_found", 404);
  if (source.message.agentRun) {
    let run: unknown;
    try {
      run = JSON.parse(source.message.agentRun);
    } catch {
      throw new ArtifactServiceError("source_not_ready", 409);
    }
    const status =
      run && typeof run === "object" && !Array.isArray(run)
        ? (run as { status?: unknown }).status
        : null;
    if (run !== null && status !== "completed" && status !== "failed" && status !== "cancelled") {
      throw new ArtifactServiceError("source_not_ready", 409);
    }
  }
  const content = assistantMessageContent(source.message.content, source.message.agentRun);
  if (!content.trim()) throw new ArtifactServiceError("source_not_ready", 409);
  return {
    content: validateContent(content),
    format: outputFormat,
    sourceConversationId: source.conversation.id,
    sourceMessageId: source.message.id,
    sourceTitle: source.conversation.title,
    sourceProjectId: source.conversation.projectId,
  };
}

// Serialize writes to the same artifact in this process; the SQL CAS and unique
// version index remain authoritative across other server processes.
const artifactWrites = new Map<string, Promise<void>>();

async function writeArtifact<T>(artifactId: string, action: () => Promise<T>): Promise<T> {
  const previous = artifactWrites.get(artifactId);
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  artifactWrites.set(artifactId, pending);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (artifactWrites.get(artifactId) === pending) artifactWrites.delete(artifactId);
  }
}

export async function restoreArtifact(
  userId: string,
  artifactId: string,
  sourceVersion: unknown,
  expectedVersion: unknown,
) {
  if (
    typeof sourceVersion !== "number" ||
    !Number.isSafeInteger(sourceVersion) ||
    sourceVersion < 1
  )
    return invalid();
  const source = await getArtifactDetail(userId, artifactId, sourceVersion);
  return appendArtifactVersion(userId, artifactId, {
    expectedVersion,
    content: source.version.content,
    format: source.version.format,
  });
}

export async function listArtifacts(userId: string): Promise<SavedArtifact[]> {
  const rows = await db
    .select()
    .from(savedArtifacts)
    .where(eq(savedArtifacts.userId, userId))
    .orderBy(desc(savedArtifacts.updatedAt), asc(savedArtifacts.id));
  return rows.map(toArtifact);
}

export async function getArtifactDetail(
  userId: string,
  artifactId: string,
  selectedVersion?: number,
): Promise<ArtifactDetail> {
  if (
    selectedVersion !== undefined &&
    (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1)
  )
    return invalid();
  const artifact = await ownedArtifact(db, userId, artifactId);
  const [version] = await db
    .select()
    .from(savedArtifactVersions)
    .where(
      and(
        eq(savedArtifactVersions.artifactId, artifactId),
        eq(savedArtifactVersions.version, selectedVersion ?? artifact.currentVersion),
      ),
    )
    .limit(1);
  if (!version) throw new ArtifactServiceError("artifact_not_found", 404);
  const versions = await db
    .select({
      artifactId: savedArtifactVersions.artifactId,
      version: savedArtifactVersions.version,
      format: savedArtifactVersions.format,
      sourceConversationId: savedArtifactVersions.sourceConversationId,
      sourceMessageId: savedArtifactVersions.sourceMessageId,
      createdAt: savedArtifactVersions.createdAt,
    })
    .from(savedArtifactVersions)
    .where(eq(savedArtifactVersions.artifactId, artifactId))
    .orderBy(desc(savedArtifactVersions.version));
  return {
    artifact: toArtifact(artifact),
    version: toVersion(version),
    versions: versions.map(
      (row): ArtifactVersionInfo => ({ ...row, createdAt: row.createdAt.toISOString() }),
    ),
  };
}

export async function createArtifact(
  userId: string,
  value: unknown,
): Promise<ArtifactMutationResult> {
  const input = object(value);
  return db.transaction(async (tx) => {
    const source = await resolveContent(tx, userId, input);
    const sourceProject = source.sourceProjectId
      ? await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, source.sourceProjectId), eq(projects.userId, userId)))
          .limit(1)
      : [];
    const artifact: ArtifactRow = {
      id: generateId(),
      userId,
      title:
        input.title === undefined
          ? Array.from(source.sourceTitle?.trim() || source.content.trim().split(/\r?\n/, 1)[0])
              .slice(0, 200)
              .join("")
          : title(input.title),
      projectId:
        input.projectId === undefined
          ? (sourceProject[0]?.id ?? null)
          : await ownedProject(tx, userId, input.projectId),
      currentVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const version: VersionRow = {
      id: generateId(),
      artifactId: artifact.id,
      version: 1,
      content: source.content,
      format: source.format,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.sourceMessageId,
      createdAt: artifact.createdAt,
    };
    await tx.insert(savedArtifacts).values(artifact);
    await tx.insert(savedArtifactVersions).values(version);
    return { artifact: toArtifact(artifact), version: toVersion(version) };
  });
}

export async function appendArtifactVersion(
  userId: string,
  artifactId: string,
  value: unknown,
): Promise<ArtifactMutationResult> {
  const input = object(value);
  const expectedVersion = input.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !Number.isSafeInteger(expectedVersion + 1)
  )
    return invalid();
  return writeArtifact(artifactId, () =>
    db.transaction(async (tx) => {
      const artifact = await ownedArtifact(tx, userId, artifactId);
      if (artifact.currentVersion !== expectedVersion)
        throw new ArtifactServiceError("artifact_version_conflict", 409);
      const source = await resolveContent(tx, userId, input);
      const now = new Date();
      const updated = await tx
        .update(savedArtifacts)
        .set({ currentVersion: expectedVersion + 1, updatedAt: now })
        .where(
          and(
            eq(savedArtifacts.id, artifactId),
            eq(savedArtifacts.userId, userId),
            eq(savedArtifacts.currentVersion, expectedVersion),
          ),
        );
      if (updated.rowsAffected !== 1)
        throw new ArtifactServiceError("artifact_version_conflict", 409);
      const version: VersionRow = {
        id: generateId(),
        artifactId,
        version: expectedVersion + 1,
        content: source.content,
        format: source.format,
        sourceConversationId: source.sourceConversationId,
        sourceMessageId: source.sourceMessageId,
        createdAt: now,
      };
      await tx.insert(savedArtifactVersions).values(version);
      return {
        artifact: toArtifact({ ...artifact, currentVersion: version.version, updatedAt: now }),
        version: toVersion(version),
      };
    }),
  );
}

export async function updateArtifact(
  userId: string,
  artifactId: string,
  value: unknown,
): Promise<SavedArtifact> {
  const input = object(value);
  const nextTitle = title(input.title);
  return writeArtifact(artifactId, () =>
    db.transaction(async (tx) => {
      const artifact = await ownedArtifact(tx, userId, artifactId);
      const next = {
        ...artifact,
        title: nextTitle,
        projectId:
          input.projectId === undefined
            ? artifact.projectId
            : await ownedProject(tx, userId, input.projectId),
        updatedAt: new Date(),
      };
      await tx
        .update(savedArtifacts)
        .set({ title: next.title, projectId: next.projectId, updatedAt: next.updatedAt })
        .where(and(eq(savedArtifacts.id, artifactId), eq(savedArtifacts.userId, userId)));
      return toArtifact(next);
    }),
  );
}

export async function deleteArtifact(userId: string, artifactId: string): Promise<boolean> {
  return writeArtifact(artifactId, async () => {
    const result = await db
      .delete(savedArtifacts)
      .where(and(eq(savedArtifacts.id, artifactId), eq(savedArtifacts.userId, userId)));
    if (result.rowsAffected !== 1) throw new ArtifactServiceError("artifact_not_found", 404);
    return true;
  });
}
