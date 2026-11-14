import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { BackupSizeLimitError } from "../services/backupArchiveBudget";
import { estimateExportSize, exportBackup, exportDTI } from "../services/exportService";
import {
  detectFormat,
  importChatGPT,
  importClaude,
  importDeepSeek,
  importOpenHornBackup,
} from "../services/importService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();

router.use("*", requireUser);

router.get("/export/estimate", async (c) => {
  const user = c.get("user");
  const estimate = await estimateExportSize(user.id);
  return c.json(estimate);
});

router.post("/export/backup", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ outputDir?: string }>().catch(() => ({ outputDir: undefined }));
  const outputDir = body.outputDir || path.join(process.cwd(), "data", "exports");

  try {
    const { filePath, manifest } = await exportBackup(user.id, outputDir);
    return c.json({ filePath, manifest });
  } catch (error) {
    if (error instanceof BackupSizeLimitError) return c.json({ errorCode: error.code }, 413);
    throw error;
  }
});

router.post("/export/dti", async (c) => {
  const user = c.get("user");
  const data = await exportDTI(user.id);
  return c.json(data);
});

router.post("/import/detect", async (c) => {
  const body = await c.req.json<{ filePath: string }>();
  if (!body.filePath) return c.json({ error: "filePath is required" }, 400);

  try {
    await stat(body.filePath);
  } catch {
    return c.json({ error: "文件不存在" }, 400);
  }

  try {
    const format = await detectFormat(body.filePath);
    return c.json({ format });
  } catch {
    return c.json({ error: "Invalid import archive" }, 400);
  }
});

router.post("/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ filePath: string; format?: string }>();
  if (!body.filePath) return c.json({ error: "filePath is required" }, 400);

  // `format` is a UI hint, never authorization to enter a different importer.
  let format: Awaited<ReturnType<typeof detectFormat>>;
  try {
    format = await detectFormat(body.filePath);
  } catch {
    return c.json({ error: "Invalid import archive" }, 400);
  }
  if (body.format !== undefined && body.format !== format) {
    return c.json({ error: "Import format does not match file contents" }, 400);
  }

  switch (format) {
    case "openhorn":
      return c.json(await importOpenHornBackup(user.id, body.filePath));
    case "chatgpt":
      return c.json(await importChatGPT(user.id, body.filePath));
    case "claude":
      return c.json(await importClaude(user.id, body.filePath));
    case "deepseek":
      return c.json(await importDeepSeek(user.id, body.filePath));
    default:
      return c.json(
        { error: "无法识别文件格式，支持 OpenHorn 备份、ChatGPT、Claude 或 DeepSeek 导出文件" },
        400,
      );
  }
});

export default router;
