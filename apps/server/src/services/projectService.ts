import { conversations, projects } from "db";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";
import {
  applyConversationDeletion,
  type ConversationDeletionPlan,
  finishConversationDeletion,
  planConversationDeletion,
} from "./conversationService";

export interface CreateProjectInput {
  name: string;
  rootPath: string;
}

export interface UpdateProjectInput {
  name?: string;
  isStarred?: boolean;
}

export async function listProjects(userId: string) {
  // Starred first, then by name — the order the sidebar renders them in.
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.isStarred), asc(projects.name), asc(projects.createdAt));
}

export async function getProject(userId: string, projectId: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Adds a folder as a project. Adding the same folder twice returns the existing
 * row instead of failing on the unique index — the sidebar "add folder" button
 * would otherwise surface a raw constraint error for a harmless repeat.
 */
export async function createProject(userId: string, input: CreateProjectInput) {
  const rootPath = input.rootPath.trim();
  const name = input.name.trim();
  if (!rootPath) throw new Error("rootPath is required");
  if (!name) throw new Error("name is required");

  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.rootPath, rootPath)))
    .limit(1);
  if (existing[0]) return existing[0];

  const now = new Date();
  const row = {
    id: generateId(),
    userId,
    name,
    rootPath,
    isStarred: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(projects).values(row);
  return row;
}

export async function updateProject(userId: string, projectId: string, input: UpdateProjectInput) {
  const existing = await getProject(userId, projectId);
  if (!existing) return null;

  const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (typeof input.name === "string" && input.name.trim()) updates.name = input.name.trim();
  if (typeof input.isStarred === "boolean") updates.isStarred = input.isStarred;

  await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)));
  return getProject(userId, projectId);
}

/**
 * Removes the project together with every conversation filed under it —
 * removing a folder deletes its chat history; the dialog copy warns about
 * this. All row deletes — every filed conversation and the project itself —
 * commit in a single transaction, so a failure midway rolls back to the
 * untouched state instead of leaving a half-removed project. Post-commit
 * cleanup (FTS, attachment files, rag chunks) runs afterwards and is
 * best-effort, as for a single conversation.
 */
export async function deleteProject(userId: string, projectId: string) {
  const existing = await getProject(userId, projectId);
  if (!existing) return false;

  const filed = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.projectId, projectId)));
  const plans = (
    await Promise.all(filed.map((row) => planConversationDeletion(userId, row.id)))
  ).filter((plan): plan is ConversationDeletionPlan => plan !== null);

  await db.transaction(async (tx) => {
    for (const plan of plans) {
      await applyConversationDeletion(tx, plan);
    }
    await tx.delete(projects).where(and(eq(projects.userId, userId), eq(projects.id, projectId)));
  });

  for (const plan of plans) {
    await finishConversationDeletion(plan);
  }
  return true;
}
