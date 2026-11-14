import { randomBytes } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-import-errors-http-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
process.env.OPENHORN_TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.OPENHORN_DATA_DIR = directory;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.OPENHORN_JEV_ENABLED = "false";
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error("Fixture refuses non-loopback HTTP");
    return realFetch(input, init);
  },
  { preconnect() {} },
);
const { client } = await import("../db");
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const { Hono } = await import("hono");
  const { bootstrapDatabase } = await import("../db/bootstrap");
  const { default: routes } = await import("./dataTransfer");
  await bootstrapDatabase({ backup: null });
  const app = new Hono().route("/data-transfer", routes);
  app.post("/legacy/data-transfer/import/detect", (c) =>
    c.json({ error: "Legacy archive failed" }, 400),
  );
  app.post("/future/data-transfer/import/detect", (c) =>
    c.json({ errorCode: "future_import_error", error: "Future archive failed" }, 400),
  );
  app.get("/conversations", (c) =>
    c.json({ errorCode: "import_file_not_found", error: "Unrelated failure" }, 400),
  );
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const request = async (suffix: string, body: unknown, raw = false) => {
    const response = await fetch(`${baseUrl}/data-transfer/${suffix}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? String(body) : JSON.stringify(body),
    });
    const text = await response.text();
    let responseBody: Record<string, unknown>;
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = { error: text };
    }
    return { status: response.status, body: responseBody };
  };
  const zip = async (name: string, entries: Record<string, unknown>) => {
    const filePath = path.join(directory, name);
    const archive = new ZipArchive();
    const completed = pipeline(archive, createWriteStream(filePath));
    archive.append(JSON.stringify({ formatVersion: "1.3.0" }), { name: "manifest.json" });
    for (const [name, value] of Object.entries(entries))
      archive.append(JSON.stringify(value), { name });
    await Promise.all([completed, archive.finalize()]);
    return filePath;
  };
  const missing = path.join(directory, "missing.zip");
  const broken = path.join(directory, "broken.zip");
  const chatgpt = path.join(directory, "chatgpt.json");
  const unknown = path.join(directory, "unknown.json");
  await writeFile(broken, "not a ZIP");
  await writeFile(chatgpt, JSON.stringify([{ mapping: {}, current_node: "none" }]));
  await writeFile(unknown, "{}");
  const responses = {
    missingDetect: await request("import/detect", { filePath: missing }),
    missingImport: await request("import", { filePath: missing }),
    badZipDetect: await request("import/detect", { filePath: broken }),
    badZipImport: await request("import", { filePath: broken }),
    directory: await request("import/detect", { filePath: directory }),
    invalidBody: await request("import/detect", null),
    invalidJson: await request("import", "{broken", true),
    wrongPathType: await request("import", { filePath: 123 }),
    mismatch: await request("import", { filePath: chatgpt, format: "claude" }),
    unsupported: await request("import", { filePath: unknown }),
    detectedUnknown: await request("import/detect", { filePath: unknown }),
  };
  const desktopApiUrl = new URL("../../../desktop/src/lib/serverApi.ts", import.meta.url).href;
  type Api = {
    dataTransfer: {
      detectFormat: (filePath: string) => Promise<unknown>;
      importData: (filePath: string, format?: string) => Promise<unknown>;
    };
    conversations: { list: () => Promise<unknown> };
  };
  const { createServerApi } = (await import(desktopApiUrl)) as {
    createServerApi: (options: { baseUrl: string }) => Api;
  };
  const api = createServerApi({ baseUrl });
  const capture = async (work: () => Promise<unknown>) => {
    try {
      return { value: await work() };
    } catch (error) {
      return {
        code: error && typeof error === "object" && "code" in error ? error.code : null,
        name: error instanceof Error ? error.name : null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const transported = {
    missing: await capture(() => api.dataTransfer.detectFormat(missing)),
    badZip: await capture(() => api.dataTransfer.detectFormat(broken)),
    mismatch: await capture(() => api.dataTransfer.importData(chatgpt, "claude")),
    legacy: await capture(() =>
      createServerApi({ baseUrl: `${baseUrl}/legacy` }).dataTransfer.detectFormat(broken),
    ),
    future: await capture(() =>
      createServerApi({ baseUrl: `${baseUrl}/future` }).dataTransfer.detectFormat(broken),
    ),
    unrelated: await capture(() => api.conversations.list()),
  };
  const now = Date.now();
  const conversation = (id: string) => ({ id, title: id, createdAt: now, updatedAt: now });
  const validation = await api.dataTransfer.importData(
    await zip("validation.zip", {
      "messages.json": [{ role: "user", content: "invalid identity" }],
    }),
    "openhorn",
  );
  const partial = await api.dataTransfer.importData(
    await zip("partial.zip", {
      "conversations.json": [conversation("partial-conversation")],
      "messages.json": [
        {
          id: "partial-message",
          conversationId: "partial-conversation",
          role: "user",
          content: "kept",
          createdAt: now,
        },
      ],
      "attachments.json": [
        {
          id: "missing-attachment",
          conversationId: "partial-conversation",
          messageId: "partial-message",
          fileName: "missing.pdf",
          fileType: "application/pdf",
          fileSize: 3,
          createdAt: now,
        },
      ],
    }),
    "openhorn",
  );
  await client.execute(
    "CREATE TRIGGER import_error_fixture_reject BEFORE INSERT ON settings WHEN NEW.key='fixture-fail' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END",
  );
  const interrupted = await api.dataTransfer.importData(
    await zip("interrupted.zip", {
      "conversations.json": [conversation("interrupted-conversation")],
      "settings.json": [
        {
          id: "interrupted-setting",
          key: "fixture-fail",
          value: "fixture",
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    "openhorn",
  );
  await server.stop(true);
  const disconnected = await capture(() => api.dataTransfer.detectFormat(broken));
  console.log(
    JSON.stringify({
      baseUrl,
      responses,
      transported,
      validation,
      partial,
      interrupted,
      disconnected,
    }),
  );
} finally {
  await server?.stop(true);
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
