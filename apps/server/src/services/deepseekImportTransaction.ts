/** Explicit LibSQL lifecycle: a busy COMMIT may be retried on the same transaction. */
import { LibSQLSession, LibSQLTransaction } from "drizzle-orm/libsql";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { client } from "../db";

type Writer = Pick<
  LibSQLTransaction<Record<string, never>, Record<string, never>>,
  "insert" | "select" | "update"
>;

function isBusy(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    if (
      "code" in cause &&
      ["SQLITE_BUSY", "SQLITE_BUSY_TIMEOUT", "SQLITE_LOCKED"].includes(String(cause.code))
    )
      return true;
    cause = "cause" in cause ? cause.cause : null;
  }
  return false;
}

/** Only retry SQLite lock refusals, never ambiguous acknowledgements or constraints. */
export async function retryDeepSeekBusy<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!isBusy(error) || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, 5 * 2 ** attempt)));
    }
  }
}

let queue: Promise<void> = Promise.resolve();
export async function deepseekTransaction<T>(work: (tx: Writer) => Promise<T>): Promise<T> {
  const previous = queue;
  let release = () => {};
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const raw = await retryDeepSeekBusy(() => client.transaction("write"));
    const dialect = new SQLiteAsyncDialect();
    const session = new LibSQLSession(client, dialect, undefined, {}, raw);
    const tx = new LibSQLTransaction("async", dialect, session, undefined);
    try {
      const result = await work(tx);
      // The stock db.transaction rolls back immediately on a busy COMMIT.
      // Keep the same SQL transaction and file effects until commit succeeds.
      await retryDeepSeekBusy(() => raw.commit());
      return result;
    } catch (error) {
      if (!raw.closed) await raw.rollback();
      throw error;
    } finally {
      raw.close();
    }
  } finally {
    release();
  }
}
