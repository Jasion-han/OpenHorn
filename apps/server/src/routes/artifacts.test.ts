import { expect, test } from "bun:test";

test("artifact HTTP endpoints preserve original text, immutable history and structured failures", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./artifacts.fixture.ts", import.meta.url).pathname],
    {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "file::memory:" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.created).toBe(201);
  expect(result.exactContent).toBe(true);
  expect(result.appended).toBe(201);
  expect(result.currentVersion).toBe(2);
  expect(result.historicalExact).toBe(true);
  expect(result.historyContainsContent).toBe(false);
  expect(result.conflict).toMatchObject({ status: 409, errorCode: "artifact_version_conflict" });
  expect(result.malformed).toMatchObject({ status: 400, errorCode: "invalid_artifact" });
  expect(result.invalidVersion).toMatchObject({ status: 400, errorCode: "invalid_artifact" });
  expect(result.missingSource).toMatchObject({ status: 404, errorCode: "source_not_found" });
  expect(result.renamed).toMatchObject({ status: 200, artifact: { title: "Renamed" } });
  expect(result.list).toEqual(["Renamed"]);
  expect(result.removed).toMatchObject({ status: 200, success: true });
  expect(result.missing).toMatchObject({ status: 404, errorCode: "artifact_not_found" });
});
