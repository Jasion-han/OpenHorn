import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactDetail, ArtifactMutationResult, SavedArtifact } from "shared/types";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-artifact-http-"));

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
const { Hono } = await import("hono");
const { client, db } = await import("../db");
try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  const { users } = await import("db");
  const { default: artifactRoutes } = await import("./artifacts");
  await bootstrapDatabase();
  await db.insert(users).values({
    id: "artifact-http-user",
    email: "artifact-http@test.invalid",
    username: "artifact-http",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const app = new Hono();
  app.route("/artifacts", artifactRoutes);
  const headers = { "Content-Type": "application/json" };
  const raw = "<p>完整原文</p>\r\n<script>const n = 1;</script>\n";
  const created = await app.request("/artifacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "HTTP artifact", content: raw, format: "html" }),
  });
  const saved = (await created.json()) as ArtifactMutationResult;
  const appended = await app.request(`/artifacts/${saved.artifact.id}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 1, content: "new raw content", format: "markdown" }),
  });
  const current = (await appended.json()) as ArtifactMutationResult;
  const detail = await app.request(`/artifacts/${saved.artifact.id}?version=1`);
  const historical = (await detail.json()) as ArtifactDetail;
  const conflict = await app.request(`/artifacts/${saved.artifact.id}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: 1, content: "stale edit" }),
  });
  const malformed = await app.request("/artifacts", { method: "POST", headers, body: "{" });
  const invalidVersion = await app.request(`/artifacts/${saved.artifact.id}?version=NaN`);
  const missingSource = await app.request("/artifacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ sourceMessageId: "missing-source" }),
  });
  const renamed = await app.request(`/artifacts/${saved.artifact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "Renamed", projectId: null }),
  });
  const list = await app.request("/artifacts");
  const listBody = (await list.json()) as { artifacts: SavedArtifact[] };
  const removed = await app.request(`/artifacts/${saved.artifact.id}`, { method: "DELETE" });
  const missing = await app.request(`/artifacts/${saved.artifact.id}`);
  console.log(
    JSON.stringify({
      created: created.status,
      exactContent: saved.version.content === raw,
      appended: appended.status,
      currentVersion: current.artifact.currentVersion,
      historicalExact: historical.version.content === raw,
      historyContainsContent: historical.versions.some((version: object) => "content" in version),
      conflict: {
        status: conflict.status,
        ...((await conflict.json()) as Record<string, unknown>),
      },
      malformed: {
        status: malformed.status,
        ...((await malformed.json()) as Record<string, unknown>),
      },
      invalidVersion: {
        status: invalidVersion.status,
        ...((await invalidVersion.json()) as Record<string, unknown>),
      },
      missingSource: {
        status: missingSource.status,
        ...((await missingSource.json()) as Record<string, unknown>),
      },
      renamed: { status: renamed.status, ...((await renamed.json()) as Record<string, unknown>) },
      list: listBody.artifacts.map((artifact: { title: string }) => artifact.title),
      removed: { status: removed.status, ...((await removed.json()) as Record<string, unknown>) },
      missing: { status: missing.status, ...((await missing.json()) as Record<string, unknown>) },
    }),
  );
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
