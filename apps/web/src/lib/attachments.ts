import { API_BASE } from "./api";

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

  const res = await fetch(`${API_BASE}/attachments/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(message || "Failed to upload attachments");
  }

  return res.json() as Promise<{
    attachments: Array<{
      id: string;
      fileName: string;
      fileType: string;
      fileSize: number;
    }>;
  }>;
}
