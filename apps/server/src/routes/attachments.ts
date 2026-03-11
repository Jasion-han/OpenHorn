import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentSessions, conversations } from 'db';
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

export default attachments;
