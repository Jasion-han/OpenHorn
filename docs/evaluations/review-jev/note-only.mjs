import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ENDPOINT, MODEL, outcome, POLICY, PRICE_PER_MILLION, payloadFor } from "./probe.mjs";

export function notePayloadFor(item) {
  const original = payloadFor(item);
  return {
    model: MODEL,
    state: { review: { text: item.text }, annotation: { note: item.note } },
    questions: { note: original.questions.note },
  };
}
export async function runNoteOnly(budgetUsd) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw new Error("An approved budget is required.");
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY unavailable");
  const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
  const prior = JSON.parse(
    await readFile(new URL("./results/live-results.json", import.meta.url), "utf8"),
  );
  const records = [],
    reserve = (65536 * PRICE_PER_MILLION) / 1e6;
  const directory = new URL("./note-only-results/", import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const item of cases) {
    if ((prior.length + records.length + 1) * reserve > budgetUsd)
      throw new Error("Approved cumulative budget exhausted");
    const payload = notePayloadFor(item),
      start = performance.now();
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    const record = {
      id: item.id,
      split: item.split,
      payload,
      status: response.status,
      latencyMs: Math.round(performance.now() - start),
      ...(response.ok
        ? { response: data, estimatedCostUsd: (data.usage.input_tokens * PRICE_PER_MILLION) / 1e6 }
        : { error: { status: response.status } }),
    };
    records.push(record);
    await writeFile(
      new URL("live-results.json", directory),
      `${JSON.stringify(records, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        id: item.id,
        status: record.status,
        probability: response.ok ? data.answers.note.noul : undefined,
        latencyMs: record.latencyMs,
      }),
    );
    if (!response.ok) break;
  }
  const summary = {
    model: MODEL,
    policy: POLICY,
    calls: records.length,
    cumulativeReservedUpperBoundUsd: (prior.length + records.length) * reserve,
    estimatedCostUsd: records.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0),
    splits: Object.fromEntries(
      ["explore", "holdout"].map((split) => {
        const rows = records
          .filter((r) => r.split === split && r.status === 200)
          .map((r) => ({
            expected: cases.find((c) => c.id === r.id).expected.note,
            verdict: outcome(r.response.answers.note.noul),
          }));
        return [
          split,
          {
            total: rows.length,
            detectedErrors: rows.filter((r) => !r.expected && r.verdict === "unsupported").length,
            missedErrors: rows.filter((r) => !r.expected && r.verdict === "supported").length,
            falseWarnings: rows.filter((r) => r.expected && r.verdict === "unsupported").length,
            correctSupported: rows.filter((r) => r.expected && r.verdict === "supported").length,
            uncertain: rows.filter((r) => r.verdict === "uncertain").length,
          },
        ];
      }),
    ),
  };
  await writeFile(new URL("summary.json", directory), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runNoteOnly(Number(process.argv[2]));
