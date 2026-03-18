import { readFile } from "node:fs/promises";
import pdf from "pdf-parse";

export async function parseAttachmentContent(input: {
  filePath: string;
  fileType: string;
  fileName: string;
}) {
  if (input.fileType === "application/pdf") {
    const data = await pdf(await readFile(input.filePath));
    return data.text || "";
  }

  if (input.fileType.startsWith("text/")) {
    return await readFile(input.filePath, "utf8");
  }

  if (input.fileType.startsWith("image/")) {
    return `[Image: ${input.fileName}, type=${input.fileType}]`;
  }

  return "";
}

export function formatAttachmentContext(items: Array<{ fileName: string; text: string }>) {
  const lines = items
    .map((item) => ({
      fileName: item.fileName,
      text: item.text.trim(),
    }))
    .filter((item) => item.text.length > 0)
    .map((item) => `- ${item.fileName}: ${item.text}`);

  if (lines.length === 0) {
    return "";
  }

  return `Attachments:\n${lines.join("\n")}`;
}
