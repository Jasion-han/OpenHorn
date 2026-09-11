import { Hono } from "hono";
import {
  createImportRecord,
  deleteImportRecord,
  getImportRecord,
  isImportKind,
  isImportSource,
  listImportRecords,
  sanitizeParts,
} from "../services/importRecordsService";
import {
  listLocalConversations,
  runLocalImport,
  scanLocalSources,
} from "../services/localImportService";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { isRecord } from "../utils/typeGuards";

const router = new Hono<UserEnv>();

router.use("*", requireUser);

// ---------------------------------------------------------------------------
// Import history
// ---------------------------------------------------------------------------

router.get("/records", async (c) => {
  const user = c.get("user");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const cursor = c.req.query("cursor") || undefined;
  const result = await listImportRecords(user.id, {
    limit: Number.isFinite(limit) ? limit : undefined,
    cursor,
  });
  return c.json(result);
});

router.get("/records/:id", async (c) => {
  const user = c.get("user");
  const record = await getImportRecord(user.id, c.req.param("id"));
  if (!record) return c.json({ error: "Import record not found" }, 404);
  return c.json({ record });
});

// Desktop-side imports (MCP / skills / credentials happen in the Tauri layer)
// report their outcome here so they show up in the same history.
router.post("/records", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (!isRecord(body)) return c.json({ error: "invalid body" }, 400);
  if (!isImportSource(body.source)) return c.json({ error: "invalid source" }, 400);
  if (!isImportKind(body.kind)) return c.json({ error: "invalid kind" }, 400);

  const parts = sanitizeParts(body.parts);
  if (parts.length === 0) return c.json({ error: "parts must be a non-empty array" }, 400);
  const errors = Array.isArray(body.errors)
    ? body.errors.filter((e): e is string => typeof e === "string")
    : [];

  const record = await createImportRecord(user.id, {
    source: body.source,
    kind: body.kind,
    parts,
    errors,
  });
  return c.json({ record }, 201);
});

router.delete("/records/:id", async (c) => {
  const user = c.get("user");
  const deleted = await deleteImportRecord(user.id, c.req.param("id"));
  if (!deleted) return c.json({ error: "Import record not found" }, 404);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Local AI-client sources (~/.claude, ~/.codex, ~/.gemini)
// ---------------------------------------------------------------------------

router.post("/local/scan", async (c) => {
  const user = c.get("user");
  const result = await scanLocalSources(user.id);
  return c.json(result);
});

router.get("/local/conversations", async (c) => {
  const user = c.get("user");
  const source = c.req.query("source");
  if (source !== "claude-code" && source !== "codex" && source !== "gemini") {
    return c.json({ error: "source must be claude-code | codex | gemini" }, 400);
  }
  const result = await listLocalConversations(user.id, source);
  return c.json(result);
});

router.post("/local/run", async (c) => {
  const user = c.get("user");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (!isRecord(body)) return c.json({ error: "invalid body" }, 400);
  const source = body.source;
  if (source !== "claude-code" && source !== "codex" && source !== "gemini") {
    return c.json({ error: "source must be claude-code | codex | gemini" }, 400);
  }
  if (!isRecord(body.parts)) return c.json({ error: "parts is required" }, 400);

  const parts: {
    conversations?: { sessionIds: string[] | "all" };
    instructions?: true;
    prompts?: true;
  } = {};
  if (isRecord(body.parts.conversations)) {
    const ids = body.parts.conversations.sessionIds;
    if (ids === "all") parts.conversations = { sessionIds: "all" };
    else if (Array.isArray(ids)) {
      parts.conversations = {
        sessionIds: ids.filter((id): id is string => typeof id === "string" && id.length > 0),
      };
    } else {
      return c.json({ error: 'conversations.sessionIds must be an array or "all"' }, 400);
    }
  }
  if (body.parts.instructions === true) parts.instructions = true;
  if (body.parts.prompts === true) parts.prompts = true;
  if (!parts.conversations && !parts.instructions && !parts.prompts) {
    return c.json({ error: "no parts selected" }, 400);
  }

  try {
    const result = await runLocalImport(user.id, { source, parts });
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "import failed" }, 400);
  }
});

export default router;
