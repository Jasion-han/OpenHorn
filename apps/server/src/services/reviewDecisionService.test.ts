import { expect, test } from "bun:test";
import { reviewWorkspaces, users } from "db";
import { eq } from "drizzle-orm";
import { JEV_RESOLVED_MODEL } from "shared/decisions";
import type { DecisionAnswer, DecisionRequest } from "shared/types";
import { db } from "../db";
import { classifyReviewBatch } from "./reviewDecisionService";
import {
  createReviewWorkspace,
  deleteReviewWorkspace,
  getReviewWorkspace,
  updateReviewAnnotation,
} from "./reviewWorkspaceService";

function evaluation(request: DecisionRequest) {
  const answers: Record<string, DecisionAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(request.questions))
    answers[id] =
      question.type === "choice"
        ? {
            type: "choice",
            choice: "positive",
            confidence: 1,
            probabilities: { positive: 1, negative: 0, neutral: 0, mixed: 0 },
          }
        : {
            type: "noul",
            noul: id.endsWith("_interpretable") || id.endsWith("_usability") ? 0.98 : 0.02,
          };
  return {
    ok: true as const,
    evaluation: {
      answers,
      model: JEV_RESOLVED_MODEL,
      providerRequestId: "synthetic",
      latencyMs: 1,
      cached: false,
      billedCostUsd: 0.0001,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
    },
  };
}
async function fixture(
  run: (
    userId: string,
    workspace: Awaited<ReturnType<typeof createReviewWorkspace>>,
  ) => Promise<void>,
) {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "jev-reviews",
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  try {
    const workspace = await createReviewWorkspace(userId, {
      title: "Synthetic",
      csv: "text,rating\nWorks well,5\nEasy to use,4",
      fileName: "synthetic.csv",
      delimiter: ",",
      textColumn: 0,
      ratingColumn: 1,
    });
    await run(userId, workspace);
  } finally {
    await db.delete(reviewWorkspaces).where(eq(reviewWorkspaces.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
}
test("Jev batch is durable and idempotent after lost ACK without creating a conversation", async () =>
  fixture(async (userId, workspace) => {
    let calls = 0;
    const evaluate = async (_u: string, _f: unknown, request: DecisionRequest) => {
      calls++;
      return evaluation(request);
    };
    const input = {
      expectedRevision: workspace.revision,
      requestId: crypto.randomUUID(),
      rowIds: workspace.data.rows.map((r) => r.id),
    };
    const result = await classifyReviewBatch(userId, workspace.id, input, evaluate);
    expect(result.run.engine).toBe("jev");
    expect(result.run.conversationId).toBeNull();
    expect(result.run.decision?.status).toBe("completed");
    expect(result.workspace.data.rows.map((row) => row.annotation?.sentiment)).toEqual([
      "positive",
      "positive",
    ]);
    expect(result.workspace.data.rows[0].annotation?.topics).toEqual(["jev:usability"]);
    expect(result.workspace.data.rows[0].annotation?.note).toBe("");
    expect((await classifyReviewBatch(userId, workspace.id, input, evaluate)).run.id).toBe(
      result.run.id,
    );
    expect(calls).toBe(1);
    expect((await getReviewWorkspace(userId, workspace.id)).data.runs).toHaveLength(1);
  }));
test("manual changes during Jev's await are skipped, keeping their note and evidence", async () =>
  fixture(async (userId, workspace) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const job = classifyReviewBatch(
      userId,
      workspace.id,
      {
        expectedRevision: workspace.revision,
        requestId: crypto.randomUUID(),
        rowIds: workspace.data.rows.map((r) => r.id),
      },
      async (_u, _f, request) => {
        entered();
        await gate;
        return evaluation(request);
      },
    );
    await started;
    const pending = await getReviewWorkspace(userId, workspace.id);
    await updateReviewAnnotation(userId, workspace.id, workspace.data.rows[0].id, {
      expectedRevision: pending.revision,
      annotation: {
        sentiment: "negative",
        topics: ["manual"],
        quote: "Works",
        note: "Manual note",
      },
    });
    release();
    const result = await job;
    expect(result.run.applied).toBe(1);
    expect(result.run.skipped).toBe(1);
    expect(result.workspace.data.rows[0].annotation?.source).toBe("manual");
    expect(result.workspace.data.rows[0].annotation?.note).toBe("Manual note");
  }));
test("failed decisions preserve old annotations and repeat request IDs never re-bill", async () =>
  fixture(async (userId, workspace) => {
    let calls = 0;
    const input = {
      expectedRevision: workspace.revision,
      requestId: crypto.randomUUID(),
      rowIds: [workspace.data.rows[0].id],
    };
    const evaluate = async () => {
      calls++;
      return { ok: false as const, reason: "budget" as const };
    };
    const result = await classifyReviewBatch(userId, workspace.id, input, evaluate);
    expect(result.run.decision?.status).toBe("failed");
    expect(result.workspace.annotatedCount).toBe(0);
    await classifyReviewBatch(userId, workspace.id, input, evaluate);
    expect(calls).toBe(1);
  }));
test("deleted workspaces are never resurrected by late Jev answers", async () =>
  fixture(async (userId, workspace) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => {
        release = done;
      }),
      started = new Promise<void>((done) => {
        entered = done;
      });
    const job = classifyReviewBatch(
      userId,
      workspace.id,
      {
        expectedRevision: workspace.revision,
        requestId: crypto.randomUUID(),
        rowIds: [workspace.data.rows[0].id],
      },
      async (_u, _f, request) => {
        entered();
        await gate;
        return evaluation(request);
      },
    );
    await started;
    const pending = await getReviewWorkspace(userId, workspace.id);
    await deleteReviewWorkspace(userId, workspace.id, pending.revision);
    release();
    await expect(job).rejects.toMatchObject({ code: "review_not_found" });
    expect(
      await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, workspace.id)),
    ).toHaveLength(0);
  }));
