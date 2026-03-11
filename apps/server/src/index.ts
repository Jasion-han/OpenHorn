import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import authRoutes from './routes/auth';
import channelRoutes from './routes/channels';
import conversationRoutes from './routes/conversations';
import messageRoutes from './routes/messages';
import agentRoutes from './routes/agent';
import workspaceRoutes from './routes/workspace';
import mcpRoutes from './routes/mcp';
import attachmentRoutes from './routes/attachments';
import settingsRoutes from './routes/settings';
import { bootstrapDatabase } from './db/bootstrap';

await bootstrapDatabase();

const app = new Hono();

app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:3001', 'http://localhost:3000'],
  credentials: true,
}));

app.get('/', (c) => c.json({ message: 'OpenHorn API', version: '1.0.0' }));

app.route('/auth', authRoutes);
app.route('/channels', channelRoutes);
app.route('/conversations', conversationRoutes);
app.route('/messages', messageRoutes);
app.route('/attachments', attachmentRoutes);
app.route('/agent', agentRoutes);
app.route('/workspaces', workspaceRoutes);
app.route('/mcp', mcpRoutes);
app.route('/settings', settingsRoutes);

const port = parseInt(process.env.PORT || '3000');

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 120,
};
