import { db } from "../db";

export type SearchSettingsTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
let tail = Promise.resolve();

/** Serialize short local transactions; upstream probes must run outside this queue. */
export async function withSearchSettingsTransaction<T>(
  work: (tx: SearchSettingsTransaction) => Promise<T>,
): Promise<T> {
  const previous = tail;
  let release: () => void = () => {};
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await db.transaction(work);
  } finally {
    release();
  }
}
