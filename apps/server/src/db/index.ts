import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from 'db';
import { fileURLToPath } from 'node:url';

const defaultDbFilePath = fileURLToPath(new URL('../../../../data/openhorn.db', import.meta.url));
const defaultDbUrl = `file:${defaultDbFilePath}`;

export const client = createClient({
  url: process.env.DATABASE_URL || defaultDbUrl,
});

export const db = drizzle(client, { schema });
