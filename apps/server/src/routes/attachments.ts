import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from '../db';
import { agentSessions, attachments as attachmentsTable, conversations } from 'db';
import { verifyToken, getUserById } from '../services/authService';
import { storeAttachment } from '../services/attachmentService';

const attachments = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return getUserById(payload.userId);
}

function inferSessionIdFromPath(filePath: string): string | null {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const marker = '/attachments/agent/';
  const idx = normalized.indexOf(marker);
  if (idx < 0) return null;
  const rest = normalized.slice(idx + marker.length);
  const [sessionId] = rest.split('/');
  return sessionId || null;
}

function sanitizeAsciiFilename(name: string): string {
  const safe = String(name || 'attachment')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_');
  return safe.length > 0 ? safe : 'attachment';
}

function contentDisposition(mode: 'inline' | 'attachment', fileName: string): string {
  const fallback = sanitizeAsciiFilename(fileName);
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

attachments.post('/upload', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.parseBody();
  const conversationId = body.conversationId?.toString() || undefined;
  const sessionId = body.sessionId?.toString() || undefined;

  if (!conversationId && !sessionId) {
    return c.json({ error: 'conversationId or sessionId is required' }, 400);
  }

  if (conversationId) {
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    if (conv.length === 0) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
  }

  if (sessionId) {
    const sess = await db.select().from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, user.id)))
      .limit(1);
    if (sess.length === 0) {
      return c.json({ error: 'Session not found' }, 404);
    }
  }

  const files = body.files;
  const uploadFiles = Array.isArray(files) ? files : files ? [files] : [];
  if (uploadFiles.length === 0) {
    return c.json({ error: 'No files uploaded' }, 400);
  }

  const results: Array<{
    id: string;
    fileName: string;
    fileType: string;
    fileSize: number;
  }> = [];

  for (const file of uploadFiles) {
    if (!(file instanceof File)) {
      continue;
    }

    try {
      const stored = await storeAttachment({ conversationId, sessionId, file });
      results.push({
        id: stored.id,
        fileName: stored.fileName,
        fileType: stored.fileType,
        fileSize: stored.fileSize,
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to store attachment',
      }, 400);
    }
  }

  if (results.length === 0) {
    return c.json({ error: 'No valid files uploaded' }, 400);
  }

  return c.json({ attachments: results }, 201);
});

attachments.get('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const id = c.req.param('id');
  const rows = await db.select().from(attachmentsTable)
    .where(eq(attachmentsTable.id, id))
    .limit(1);
  if (rows.length === 0) {
    return c.json({ error: 'Not found' }, 404);
  }

  const record = rows[0] as any;

  let authorized = false;
  const conversationId = record.conversationId as string | null | undefined;
  const sessionId = record.sessionId as string | null | undefined;

  if (conversationId) {
    const conv = await db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    authorized = conv.length > 0;
  } else {
    const effectiveSessionId = sessionId || inferSessionIdFromPath(record.filePath as string);
    if (effectiveSessionId) {
      const sess = await db.select({ id: agentSessions.id }).from(agentSessions)
        .where(and(eq(agentSessions.id, effectiveSessionId), eq(agentSessions.userId, user.id)))
        .limit(1);
      authorized = sess.length > 0;
    }
  }

  if (!authorized) {
    return c.json({ error: 'Not found' }, 404);
  }

  const download = c.req.query('download') === '1';
  const mode = download ? 'attachment' : 'inline';
  const fileType = (record.fileType as string | null | undefined) || 'application/octet-stream';

  try {
    const buffer = await readFile(record.filePath as string);
    return new Response(buffer, {
      headers: {
        'Content-Type': fileType,
        'Content-Disposition': contentDisposition(mode, record.fileName as string),
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

export default attachments;
