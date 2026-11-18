// Local, synthetic fixture. Never open the configured workspace database.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file::memory:";
const { client } = await import("../src/db");
const { bootstrapDatabase } = await import("../src/db/bootstrap");
const { estimateExportSize } = await import("../src/services/exportService");
const { listUnifiedConversations } = await import("../src/services/unifiedConversationService");
await bootstrapDatabase({ backup: null });
await client.execute(
  "INSERT INTO users(id,email,username,created_at,updated_at) VALUES('bench','bench@example.invalid','bench',1,1)",
);
async function measure(read: () => Promise<unknown>) {
  const ms: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    bytes = Buffer.byteLength(JSON.stringify(await read()));
    ms.push(performance.now() - start);
  }
  return { medianMs: Math.round(ms.sort((a, b) => a - b)[2]), bytes };
}
for (const [start, end] of [
  [1, 1000],
  [1001, 10000],
]) {
  await client.execute({
    sql: `WITH RECURSIVE seq(i) AS (VALUES(?) UNION ALL SELECT i+1 FROM seq WHERE i<?)
    INSERT INTO conversations(id,user_id,title,summary,created_at,updated_at) SELECT 'c'||i,'bench','Title '||i,printf('%01024d',i),1,i FROM seq`,
    args: [start, end],
  });
  await client.execute({
    sql: `INSERT INTO messages(id,conversation_id,role,content,created_at) SELECT 'm'||id,id,'user',printf('%01024d',updated_at),1 FROM conversations WHERE updated_at>=?`,
    args: [start],
  });
  console.log({
    end,
    fullList: await measure(() => listUnifiedConversations("bench")),
    desktopList: await measure(() => listUnifiedConversations("bench", true)),
    estimate: await measure(() => estimateExportSize("bench")),
  });
}
client.close();
export {};
