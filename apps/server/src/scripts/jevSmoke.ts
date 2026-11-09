/** Explicit, bounded synthetic validation of the production OpenRouter decision client. */
import { writeFile } from "node:fs/promises";
import { users } from "db";
import {
  duplicateDecisionRequest,
  relevanceDecisionRequest,
  reviewDecisionRequest,
  routeDecisionRequest,
  skillDecisionRequest,
} from "shared/decision-questions";
import type { DecisionRequest, JevFeature } from "shared/types";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { evaluateDecision } from "../services/decisionClient";
import { getJevStatus } from "../services/decisionUsageService";
import { evaluateReviewNote } from "../services/reviewNoteVerification";

const ownedRoot = process.env.OPENHORN_JEV_SMOKE_ROOT;
if (
  process.env.OPENHORN_JEV_SMOKE !== "1" ||
  !ownedRoot?.startsWith("/tmp/openhorn-jev-smoke-") ||
  process.env.DATABASE_URL !== `file:${ownedRoot}/isolated.db`
)
  throw new Error("Run only the explicitly enabled synthetic temporary-database smoke");
const output = process.env.OPENHORN_JEV_SMOKE_OUTPUT;
if (!output?.startsWith("/tmp/openhorn-jev-"))
  throw new Error("Use a task-owned /tmp/openhorn-jev- output");
await bootstrapDatabase({ backup: null });
const userId = crypto.randomUUID();
await db.insert(users).values({
  id: userId,
  email: `${userId}@synthetic.invalid`,
  username: "Jev synthetic smoke",
  createdAt: new Date(),
  updatedAt: new Date(),
});
const jobs: Array<{ feature: JevFeature; request: DecisionRequest }> = [
  {
    feature: "reviews",
    request: reviewDecisionRequest([{ text: "界面操作流畅，但导出经常卡住。" }]),
  },
  {
    feature: "suggestions",
    request: duplicateDecisionRequest(
      ["排查本周API为什么越来越慢", "给附件增加PDF预览"],
      ["分析最近一周接口延迟升高的原因"],
    ),
  },
  {
    feature: "rerank",
    request: relevanceDecisionRequest("重复点击任务运行会怎样？", [
      { text: "同一个requestId返回已有批次，不重复执行。" },
      { text: "窗口可以拖动和调整大小。" },
    ]),
  },
  {
    feature: "skills",
    request: skillDecisionRequest("把CSV汇总成Excel表格", [
      { name: "spreadsheet", description: "Create and analyze Excel spreadsheets" },
      { name: "document", description: "Write Markdown API documentation" },
    ]),
  },
  {
    feature: "routeShadow",
    request: routeDecisionRequest("What is the time complexity of binary search?"),
  },
];
const transport: Array<{ status?: number; name?: string; code?: string }> = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    try {
      const response = await nativeFetch(input, init);
      transport.push({ status: response.status });
      return response;
    } catch (error) {
      transport.push({
        name: error instanceof Error ? error.name : "TransportError",
        code: String((error as { code?: string }).code ?? ""),
      });
      throw error;
    }
  },
  { preconnect: nativeFetch.preconnect },
);
const records = [];
for (const job of jobs) {
  const result = await evaluateDecision(userId, job.feature, job.request);
  records.push({ feature: job.feature, request: job.request, result });
  if (result.ok === false) {
    await writeFile(
      output,
      `${JSON.stringify({ records, transport, status: await getJevStatus(userId) }, null, 2)}\n`,
    );
    throw new Error(`Synthetic Jev smoke failed: ${result.reason}`);
  }
}
const note = await evaluateReviewNote(
  "界面操作流畅，但导出经常卡住。",
  "用户认可界面流畅，反映导出卡顿。",
  { userId },
);
const status = await getJevStatus(userId);
await writeFile(output, `${JSON.stringify({ records, note, status, transport }, null, 2)}\n`);
console.log(
  JSON.stringify({
    validated: records.length + 1,
    model: note.model,
    requests: status.requests,
    spentUsd: status.spentUsd,
    reservedUsd: status.reservedUsd,
  }),
);
