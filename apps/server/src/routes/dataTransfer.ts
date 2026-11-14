import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { DataTransferImportErrorCode, DataTransferImportErrorResponse } from "shared/types";
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

function importError(
  errorCode: DataTransferImportErrorCode,
  error: string,
): DataTransferImportErrorResponse {
  return { errorCode, error };
}

function importRequest(body: unknown): { filePath: string; format?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (typeof input.filePath !== "string" || !input.filePath.trim() || input.filePath.includes("\0"))
    return null;
  if (input.format !== undefined && (typeof input.format !== "string" || !input.format))
    return null;
  return {
    filePath: input.filePath,
    ...(typeof input.format === "string" ? { format: input.format } : {}),
  };
}

function fileError(error: unknown): DataTransferImportErrorResponse | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "ENOENT" || code === "ENOTDIR")
    return importError("import_file_not_found", "文件不存在");
  if (code === "EACCES" || code === "EPERM" || code === "EISDIR")
    return importError("import_file_unreadable", "Import file is not readable");
  return null;
}

async function detectImportFile(
  filePath: string,
): Promise<{ format: Awaited<ReturnType<typeof detectFormat>> } | DataTransferImportErrorResponse> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return importError("import_file_unreadable", "Import file is not readable");
    return { format: await detectFormat(filePath) };
  } catch (error) {
    return fileError(error) ?? importError("import_invalid_archive", "Invalid import archive");
  }
}

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
  const body = importRequest(await c.req.json().catch(() => null));
  if (!body) return c.json(importError("import_invalid_request", "filePath is required"), 400);
  const detected = await detectImportFile(body.filePath);
  return "errorCode" in detected ? c.json(detected, 400) : c.json(detected);
});

router.post("/import", async (c) => {
  const user = c.get("user");
  const body = importRequest(await c.req.json().catch(() => null));
  if (!body) return c.json(importError("import_invalid_request", "filePath is required"), 400);

  // `format` is a UI hint, never authorization to enter a different importer.
  const detected = await detectImportFile(body.filePath);
  if ("errorCode" in detected) return c.json(detected, 400);
  const { format } = detected;
  if (body.format !== undefined && body.format !== format) {
    return c.json(
      importError("import_format_mismatch", "Import format does not match file contents"),
      400,
    );
  }

  try {
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
          importError(
            "import_unsupported_format",
            "无法识别文件格式，支持 OpenHorn 备份、ChatGPT、Claude 或 DeepSeek 导出文件",
          ),
          400,
        );
    }
  } catch (error) {
    const fileFailure = fileError(error);
    if (fileFailure) return c.json(fileFailure, 400);
    if (error instanceof SyntaxError)
      return c.json(importError("import_invalid_archive", "Invalid import archive"), 400);
    return c.json(importError("import_failed", "Import did not complete"), 500);
  }
});

export default router;
