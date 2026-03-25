import { getDesktopBackendBase } from "./backendBase";
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
    throw new Error(await readErrorMessage(response, "Failed to upload attachments"));
  }

  return response.json() as Promise<{
    attachments: Array<{
      id: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }>;
  }>;
}
