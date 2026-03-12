# Attachments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support file attachments (images, PDF, text) for Chat and Agent by uploading to server, storing on disk, and injecting extracted text into prompts.

**Architecture:** Add an attachments upload route that stores files under `data/attachments/{conversationId}/` for chat and `data/attachments/agent/{sessionId}/` for agent, inserts metadata into `attachments`, then include attachment-derived text in prompt building (without modifying stored message content).

**Tech Stack:** Hono, Drizzle ORM, Bun, Next.js, Mantine, pdf-parse.

---

### Task 1: Add attachment validation + storage helpers

**Files:**
- Create: `apps/server/src/services/attachmentService.ts`
- Create: `apps/server/src/services/attachmentService.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildAttachmentDir, isAllowedMimeType } from "./attachmentService";

test("buildAttachmentDir uses chat conversation directory", () => {
  const dir = buildAttachmentDir({ conversationId: "conv-1" });
  expect(dir.endsWith("/data/attachments/conv-1")).toBe(true);
});

test("buildAttachmentDir uses agent session directory", () => {
  const dir = buildAttachmentDir({ sessionId: "sess-1" });
  expect(dir.endsWith("/data/attachments/agent/sess-1")).toBe(true);
});

test("isAllowedMimeType accepts configured types", () => {
  expect(isAllowedMimeType("image/png")).toBe(true);
  expect(isAllowedMimeType("application/pdf")).toBe(true);
  expect(isAllowedMimeType("application/zip")).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/attachmentService.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db";
import { attachments } from "../schema";
import { inArray } from "drizzle-orm";
import { generateId } from "../utils";

export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

export function isAllowedMimeType(mime: string) {
  return ALLOWED_MIME_TYPES.has(mime);
}

export function buildAttachmentDir(input: { conversationId?: string; sessionId?: string }) {
  if (input.sessionId) {
    return join(process.cwd(), "data", "attachments", "agent", input.sessionId);
  }
  if (!input.conversationId) {
    throw new Error("conversationId or sessionId is required");
  }
  return join(process.cwd(), "data", "attachments", input.conversationId);
}

export async function storeAttachment(params: {
  conversationId?: string;
  sessionId?: string;
  file: File;
}) {
  if (!isAllowedMimeType(params.file.type)) {
    throw new Error("Unsupported file type");
  }
  if (params.file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error("File too large");
  }

  const id = generateId();
  const dir = buildAttachmentDir(params);
  await mkdir(dir, { recursive: true });
  const safeName = params.file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(dir, `${id}-${safeName}`);

  const buffer = Buffer.from(await params.file.arrayBuffer());
  await writeFile(filePath, buffer);

  await db.insert(attachments).values({
    id,
    conversationId: params.conversationId || null,
    messageId: null,
    fileName: params.file.name,
    filePath,
    fileType: params.file.type,
    fileSize: params.file.size,
    createdAt: new Date(),
  });

  return { id, fileName: params.file.name, filePath, fileType: params.file.type, fileSize: params.file.size };
}

export async function linkAttachmentsToMessage(attachmentIds: string[], messageId: string) {
  if (attachmentIds.length === 0) return;
  await db.update(attachments)
    .set({ messageId })
    .where(inArray(attachments.id, attachmentIds));
}

export async function getAttachmentsByIds(attachmentIds: string[]) {
  if (attachmentIds.length === 0) return [];
  return db.select().from(attachments).where(inArray(attachments.id, attachmentIds));
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/attachmentService.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/services/attachmentService.ts apps/server/src/services/attachmentService.test.ts
git commit -m "feat: add attachment storage helpers"
```

---

### Task 2: Add attachment parser (text/PDF/image metadata)

**Files:**
- Create: `apps/server/src/services/attachmentParser.ts`
- Create: `apps/server/src/services/attachmentParser.test.ts`
- Modify: `apps/server/package.json`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseAttachmentContent } from "./attachmentParser";

test("parseAttachmentContent returns text for plain text", async () => {
  const dir = join(process.cwd(), "data", "attachments", "tmp");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "hello.txt");
  await writeFile(filePath, "hello world");
  const result = await parseAttachmentContent({ filePath, fileType: "text/plain", fileName: "hello.txt" });
  expect(result).toContain("hello world");
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/attachmentParser.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

```ts
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
    .filter((item) => item.text.trim().length > 0)
    .map((item) => `- ${item.fileName}: ${item.text.trim()}`);
  return lines.length > 0 ? `Attachments:\n${lines.join("\n")}` : "";
}
```

**Step 4: Add dependency**

Run: `cd apps/server && bun add pdf-parse`  
Expected: package.json updated.

**Step 5: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/attachmentParser.test.ts`  
Expected: PASS.

**Step 6: Commit**

```bash
git add apps/server/package.json apps/server/src/services/attachmentParser.ts apps/server/src/services/attachmentParser.test.ts
git commit -m "feat: add attachment parser"
```

---

### Task 3: Add upload route for attachments

**Files:**
- Create: `apps/server/src/routes/attachments.ts`
- Modify: `apps/server/src/index.ts`

**Step 1: Write minimal implementation**

```ts
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verifyToken, getUserById } from "../services/authService";
import { storeAttachment } from "../services/attachmentService";
import { db } from "../db";
import { conversations, agentSessions } from "../schema";
import { and, eq } from "drizzle-orm";

const attachments = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, "token");
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  return getUserById(payload.userId);
}

attachments.post("/upload", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.parseBody();
  const conversationId = body.conversationId?.toString() || undefined;
  const sessionId = body.sessionId?.toString() || undefined;

  if (!conversationId && !sessionId) {
    return c.json({ error: "conversationId or sessionId is required" }, 400);
  }

  if (conversationId) {
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    if (conv.length === 0) return c.json({ error: "Conversation not found" }, 404);
  }

  if (sessionId) {
    const sess = await db.select().from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, user.id)))
      .limit(1);
    if (sess.length === 0) return c.json({ error: "Session not found" }, 404);
  }

  const files = body.files;
  const uploadFiles = Array.isArray(files) ? files : files ? [files] : [];
  if (uploadFiles.length === 0) return c.json({ error: "No files uploaded" }, 400);

  const results = [];
  for (const file of uploadFiles) {
    if (!(file instanceof File)) continue;
    const stored = await storeAttachment({ conversationId, sessionId, file });
    results.push(stored);
  }

  return c.json({ attachments: results }, 201);
});

export default attachments;
```

Register route in `index.ts`:

```ts
import attachmentRoutes from "./routes/attachments";
app.route("/attachments", attachmentRoutes);
```

**Step 2: Manual verification**

Run:
```bash
curl -i -X POST http://localhost:3000/attachments/upload \
  -b "token=YOUR_TOKEN" \
  -F "conversationId=YOUR_CONV_ID" \
  -F "files=@/path/to/test.txt"
```
Expected: `201` with attachments array, and file under `data/attachments/YOUR_CONV_ID/`.

**Step 3: Commit**

```bash
git add apps/server/src/routes/attachments.ts apps/server/src/index.ts
git commit -m "feat: add attachments upload route"
```

---

### Task 4: Inject attachments into chat prompt building

**Files:**
- Modify: `apps/server/src/services/messageService.ts`

**Step 1: Write minimal implementation**

Add helper to build message content with attachments:

```ts
import { getAttachmentsByIds, linkAttachmentsToMessage } from "./attachmentService";
import { parseAttachmentContent, formatAttachmentContext } from "./attachmentParser";

async function buildContentWithAttachments(content: string, attachmentIds?: string[]) {
  if (!attachmentIds || attachmentIds.length === 0) return content;
  const attachments = await getAttachmentsByIds(attachmentIds);
  const parsed = [];
  for (const attachment of attachments) {
    try {
      const text = await parseAttachmentContent(attachment);
      parsed.push({ fileName: attachment.fileName, text });
    } catch {
      parsed.push({ fileName: attachment.fileName, text: "" });
    }
  }
  const context = formatAttachmentContext(parsed);
  return context ? `${content}\n\n${context}` : content;
}
```

Then replace `buildChatMessages` with async logic:

```ts
async function buildChatMessages(
  conversationMessages: Array<{ role: string; content: string; attachments?: string | null }>,
  systemPrompt?: string | null
) {
  const messages: ChatMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

  for (const message of conversationMessages) {
    if (message.role === "user" && message.attachments) {
      const attachmentIds = JSON.parse(message.attachments) as string[];
      const content = await buildContentWithAttachments(message.content, attachmentIds);
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: message.role as ChatMessage["role"], content: message.content });
    }
  }
  return messages;
}
```

In `sendMessage` and `streamMessage`, after inserting user message:

```ts
if (input.attachments?.length) {
  await linkAttachmentsToMessage(input.attachments, userMessageId);
}
```

And when calling `buildChatMessages`, await it:

```ts
const chatMessages = await buildChatMessages(conversationMessages, conversation.systemPrompt);
```

**Step 2: Manual verification**

Send a message with attachments, confirm model can reference attachment text (in a PDF or txt).

**Step 3: Commit**

```bash
git add apps/server/src/services/messageService.ts
git commit -m "feat: inject attachment text into chat prompts"
```

---

### Task 5: Inject attachments into agent prompts

**Files:**
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/routes/agent.ts`

**Step 1: Implement**

Extend run input to include attachments:

```ts
// in routes/agent.ts
const { prompt, attachments } = body;
for await (const event of runAgent(user.id, sessionId, prompt, attachments || [])) { ... }
```

In `agentService.ts`:

```ts
import { getAttachmentsByIds } from "./attachmentService";
import { parseAttachmentContent, formatAttachmentContext } from "./attachmentParser";

async function buildAgentPrompt(prompt: string, attachmentIds: string[]) {
  if (attachmentIds.length === 0) return prompt;
  const attachments = await getAttachmentsByIds(attachmentIds);
  const parsed = [];
  for (const attachment of attachments) {
    const text = await parseAttachmentContent(attachment);
    parsed.push({ fileName: attachment.fileName, text });
  }
  const context = formatAttachmentContext(parsed);
  return context ? `${prompt}\n\n${context}` : prompt;
}
```

Then update `runAgent` signature and call:

```ts
export async function* runAgent(userId: string, sessionId: string, prompt: string, attachmentIds: string[]) {
  ...
  const finalPrompt = await buildAgentPrompt(prompt, attachmentIds);
  for await (const event of runClaudeAgentSdk({ ... , prompt: finalPrompt })) { ... }
}
```

**Step 2: Manual verification**

Upload a txt/PDF to agent session, run a task that references the attachment contents.

**Step 3: Commit**

```bash
git add apps/server/src/services/agentService.ts apps/server/src/routes/agent.ts
git commit -m "feat: inject attachment text into agent prompts"
```

---

### Task 6: Add web attachment upload helper

**Files:**
- Create: `apps/web/src/lib/attachments.ts`
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Implement**

```ts
// apps/web/src/lib/attachments.ts
import { API_BASE } from "./api";

export async function uploadAttachments(input: {
  conversationId?: string;
  sessionId?: string;
  files: File[];
}) {
  const form = new FormData();
  if (input.conversationId) form.append("conversationId", input.conversationId);
  if (input.sessionId) form.append("sessionId", input.sessionId);
  input.files.forEach((file) => form.append("files", file));

  const res = await fetch(`${API_BASE}/attachments/upload`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ attachments: Array<{ id: string; fileName: string; fileType: string; fileSize: number }> }>;
}
```

Expose in `api.ts` (optional wrapper):

```ts
attachments: {
  upload: uploadAttachments,
},
```

**Step 2: Commit**

```bash
git add apps/web/src/lib/attachments.ts apps/web/src/lib/api.ts
git commit -m "feat: add attachment upload client helper"
```

---

### Task 7: Chat UI attachments integration

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/lib/chat-stream.ts`

**Step 1: Implement**

Add UI state and file picker:

```tsx
const [files, setFiles] = useState<File[]>([]);
...
<FileButton onChange={(file) => file && setFiles((prev) => [...prev, file])}>
  {(props) => <Button variant="light" {...props}>Attach</Button>}
</FileButton>
```

On send:

```tsx
let attachmentIds: string[] = [];
if (files.length) {
  const { attachments } = await uploadAttachments({ conversationId, files });
  attachmentIds = attachments.map((a) => a.id);
  setFiles([]);
}
await streamChatMessage({ conversationId, content: input, attachments: attachmentIds }, ...)
```

Update `streamChatMessage` signature + `api.messages.stream` to accept `attachments`.

**Step 2: Manual verification**

Attach a txt file, send, confirm model can reference it.

**Step 3: Commit**

```bash
git add apps/web/src/components/ChatArea.tsx apps/web/src/lib/chat-stream.ts apps/web/src/lib/api.ts
git commit -m "feat: add chat attachments upload"
```

---

### Task 8: Agent UI attachments integration

**Files:**
- Modify: `apps/web/src/app/agent/page.tsx`
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Implement**

Add file picker and pass attachment ids:

```tsx
const [agentFiles, setAgentFiles] = useState<File[]>([]);
...
const { attachments } = await uploadAttachments({ sessionId: currentSession.id, files: agentFiles });
const attachmentIds = attachments.map((a) => a.id);
await api.agent.runSession(currentSession.id, input.trim(), attachmentIds);
```

Update `api.agent.runSession` to accept `attachments?: string[]` in body.

**Step 2: Manual verification**

Attach a file and run the agent, confirm output references attachment.

**Step 3: Commit**

```bash
git add apps/web/src/app/agent/page.tsx apps/web/src/lib/api.ts
git commit -m "feat: add agent attachments upload"
```

---

## Notes

- If git is not configured, skip commit steps.
- Attachments are injected at inference time only; stored message content remains unchanged.
