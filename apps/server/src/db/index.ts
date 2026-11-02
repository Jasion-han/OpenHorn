import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import * as schema from "db";
import { drizzle } from "drizzle-orm/libsql";
import { assertIsolatedTestDatabase } from "./testDatabaseGuard";

const defaultDbFilePath = fileURLToPath(new URL("../../../../data/openhorn.db", import.meta.url));
const defaultDbUrl = `file:${defaultDbFilePath}`;

/** The URL the client below was opened with (bootstrap derives the backup location from it). */
export const databaseUrl = process.env.DATABASE_URL || defaultDbUrl;

assertIsolatedTestDatabase(databaseUrl, defaultDbFilePath);

export const client = createClient({
  url: databaseUrl,
});

export const db = drizzle(client, { schema });
