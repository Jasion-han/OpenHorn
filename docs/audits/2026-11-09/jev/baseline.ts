// Run with the server test preload and an explicit temporary SQL database.
import { readFile, writeFile } from "node:fs/promises";
import { routeLiveQuery } from "../../../../apps/server/src/services/liveCapabilities";
import { dropEchoes } from "../../../../apps/server/src/services/welcomeSuggestionService";
import { buildIntentContext } from "../../../../apps/sidecar/src/agent/intent-context";

const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
const requests: string[] = [];
// No current-weather request should escape this synthetic-only comparison.
globalThis.fetch = (async (input: unknown) => {
  requests.push(String(input));
  throw new Error("External requests disabled in the baseline");
}) as unknown as typeof fetch;
const routing = [];
for (const item of cases.routing) {
  const sidecar = await buildIntentContext(item.prompt);
  const expectedSidecar =
    item.expected === "local"
      ? "local_time"
      : item.expected === "structured_live"
        ? "weather"
        : "none";
  const server = routeLiveQuery(item.prompt).type;
  routing.push({
    ...item,
    server,
    serverCorrect: server === item.expected,
    sidecar: sidecar.route,
    expectedSidecar,
    sidecarCorrect: sidecar.route === expectedSidecar,
  });
}
const duplicates = cases.duplicates.map(
  (item: { recent: string; suggestion: string; expected: boolean }) => ({
    ...item,
    actual: dropEchoes([item.suggestion], [item.recent]).length === 0,
  }),
);
await writeFile(
  new URL("./baseline-results.json", import.meta.url),
  `${JSON.stringify({ routing, duplicates, blockedWeatherRequests: requests.length }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    server: routing.filter((item) => item.serverCorrect).length,
    sidecarTimeWeatherOnly: routing.filter((item) => item.sidecarCorrect).length,
    cases: routing.length,
    duplicates: duplicates.filter(
      (item: { expected: boolean; actual: boolean }) => item.actual === item.expected,
    ).length,
  }),
);
