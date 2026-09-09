import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { estimateExportSize, exportBackup, exportDTI } from "../services/exportService";
import {
  detectFormat,
  importChatGPT,
  importClaude,
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

  const { filePath, manifest } = await exportBackup(user.id, outputDir);
  return c.json({ filePath, manifest });
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

  const format = await detectFormat(body.filePath);
  return c.json({ format });
});

router.post("/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ filePath: string; format?: string }>();
  if (!body.filePath) return c.json({ error: "filePath is required" }, 400);

  const format = body.format || (await detectFormat(body.filePath));

  switch (format) {
    case "openhorn":
      return c.json(await importOpenHornBackup(user.id, body.filePath));
    case "chatgpt":
      return c.json(await importChatGPT(user.id, body.filePath));
    case "claude":
      return c.json(await importClaude(user.id, body.filePath));
    default:
      return c.json(
        { error: "无法识别文件格式，支持 OpenHorn 备份、ChatGPT 或 Claude 导出文件" },
        400,
      );
  }
});

export default router;
