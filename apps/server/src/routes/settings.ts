import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import { deleteSettingValue, getSettingValues, setSettingValue } from '../services/settingsService';

const settings = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return getUserById(payload.userId);
}

function parseKeysQuery(input: string | null | undefined): string[] {
  if (!input) return [];
  return input
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

settings.get('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const keys = parseKeysQuery(c.req.query('keys'));
  const values = await getSettingValues(user.id, keys);
  return c.json({ settings: values });
});

settings.put('/:key', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const key = c.req.param('key');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }

  const value = (body as any)?.value as unknown;
  try {
    if (value === null) {
      await deleteSettingValue(user.id, key);
      return c.json({ success: true });
    }

    if (typeof value === 'string') {
      await setSettingValue(user.id, key, value);
      return c.json({ success: true });
    }

    return c.json({ error: 'value must be a string or null' }, 400);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to update setting' }, 400);
  }
});

export default settings;

