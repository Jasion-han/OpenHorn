import { getDesktopBackendBase } from "./backendBase";
import { DocumentInputError } from "./documentInput";
import { readErrorMessage } from "./serverApi";

export async function uploadAttachments(input: {
  conversationId?: string;
  sessionId?: string;
  files: File[];
}) {
  const form = new FormData();

  if (input.conversationId) {
    form.append("conversationId", input.conversationId);
  }

  if (input.sessionId) {
    form.append("sessionId", input.sessionId);
  }

  for (const file of input.files) {
    form.append("files", file);
  }

  const response = await fetch(`${getDesktopBackendBase()}/attachments/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!response.ok) {
    const payload = await response
      .clone()
      .json()
      .catch(() => null);
    if (payload?.errorCode === "attachment_payload_too_large")
      throw new DocumentInputError("document_size");
    throw new Error(await readErrorMessage(response, "Failed to upload attachments"));
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new DocumentInputError("document_upload");
  }
  const uploaded =
    result && typeof result === "object" && "attachments" in result ? result.attachments : null;
  if (
    !Array.isArray(uploaded) ||
    uploaded.length !== input.files.length ||
    uploaded.some(
      (item, index) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.fileType !== "string" ||
        !item.fileType ||
        (["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(
          input.files[index].type,
        ) &&
          item.fileType !== input.files[index].type) ||
        item.fileName !== input.files[index].name ||
        item.fileSize !== input.files[index].size,
    ) ||
    new Set(uploaded.map((item) => item.id)).size !== uploaded.length
  )
    throw new DocumentInputError("document_upload");
  return result as {
    attachments: Array<{
      id: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }>;
  };
}
