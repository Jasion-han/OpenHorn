import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { DocumentChunk } from "./vectorStore";

const [owned, scenario = "concurrent"] = process.argv.slice(2);
process.chdir(owned);
const module = await import("./vectorStore");
const directory = path.join(owned, "data", "vectors");
const store = "createVectorStore" in module ? module.createVectorStore(directory) : module;
const makeChunk = (index: number): DocumentChunk => ({
  id: `synthetic-${index}`,
  userId: "synthetic-user",
  conversationId: "synthetic-conversation",
  attachmentId: `synthetic-attachment-${index}`,
  chunkIndex: 0,
  text: `synthetic-${index}`,
  vector: [1, ...new Array(1535).fill(0)],
  fileName: "synthetic.txt",
  createdAt: 1,
});
if (scenario === "retry") {
  const directory = path.join(owned, "blocked");
  await writeFile(directory, "synthetic obstruction");
  const retryStore = module.createVectorStore(directory);
  let rejected = false;
  try {
    await retryStore.addChunks([makeChunk(0)]);
  } catch {
    rejected = true;
  }
  await rm(directory);
  await retryStore.addChunks([makeChunk(0)]);
  await writeFile(
    path.join(owned, "result.json"),
    JSON.stringify({ rejected, recovered: await retryStore.hasChunksForUser("synthetic-user") }),
  );
  process.exit(0);
}
const otherStore = scenario === "independent" ? module.createVectorStore(directory) : store;
const outcomes = await Promise.allSettled(
  Array.from({ length: 6 }, (_, index) =>
    (index % 2 ? store : otherStore).addChunks([makeChunk(index)]),
  ),
);
const table = await (await lancedb.connect(directory)).openTable("document_chunks");
const rows = await table.countRows();
await store.deleteChunksByConversation("synthetic-conversation");
const emptyAfterDelete = !(await store.hasChunksForUser("synthetic-user"));
await store.addChunks([makeChunk(9)]);
const freshTable = await (await lancedb.connect(directory)).openTable("document_chunks");
await writeFile(
  path.join(owned, "result.json"),
  JSON.stringify({
    rejected: outcomes.filter((outcome) => outcome.status === "rejected").length,
    rows,
    emptyAfterDelete,
    afterReadd: await freshTable.countRows(),
    sentinel: await table.countRows("id = '__init__'"),
  }),
);
