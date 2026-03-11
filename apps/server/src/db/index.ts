import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../schema';

const client = createClient({
  // Use env override in all environments; fall back to repo-local sqlite file.
  url: process.env.DATABASE_URL || 'file:./data/openhorn.db',
});

export const db = drizzle(client, { schema });
