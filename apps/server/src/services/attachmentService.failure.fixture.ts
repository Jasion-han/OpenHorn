import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachments, channels, conversations, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { encrypt } from "../utils";
import { buildAttachmentDir, getEmbeddingApiKey, storeAttachment } from "./attachmentService";

const root = process.argv[2],
  mode = process.argv[3];
const now = new Date(),
  userId = crypto.randomUUID(),
  conversationId = crypto.randomUUID();
await db.insert(users).values({
  id: userId,
  username: "lifecycle-fixture",
  email: `${userId}@test.local`,
  createdAt: now,
  updatedAt: now,
});
let result: Record<string, unknown>;
if (mode.startsWith("upload")) {
  await db
    .insert(conversations)
    .values({ id: conversationId, userId, title: "fixture", createdAt: now, updatedAt: now });
  const directory = buildAttachmentDir({ conversationId });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "original.txt"), "keep original");
  if (mode === "upload")
    await client.execute(
      "CREATE TRIGGER reject_fixture_upload BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END",
    );
  if (mode === "upload-ack") {
    const insert = db.insert.bind(db);
    Object.assign(db, {
      insert: (table: typeof attachments) => ({
        values: async (values: typeof attachments.$inferInsert) => {
          await insert(table).values(values);
          throw new Error("synthetic lost acknowledgement");
        },
      }),
    });
  }
  let rejected = false;
  try {
    await storeAttachment({
      conversationId,
      file: new File(["synthetic upload"], "fixture.txt", { type: "text/plain" }),
    });
  } catch {
    rejected = true;
  }
  const remaining = await readdir(directory);
  const stored = await db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(eq(attachments.conversationId, conversationId));
  result = {
    rejected,
    remaining,
    original: await readFile(path.join(directory, "original.txt"), "utf8"),
    storedRows: stored.length,
    storedText: stored[0] ? await readFile(stored[0].filePath, "utf8") : null,
  };
} else {
  const seed = async (protocol: string, key: string) => {
    await db.insert(channels).values({
      id: crypto.randomUUID(),
      userId,
      name: `fixture-${protocol}`,
      provider: protocol,
      protocol,
      apiKey: encrypt(key),
      enabled: true,
      isDefault: false,
      baseUrl: "https://fixture.invalid",
      createdAt: now,
      updatedAt: now,
    });
  };
  await seed("anthropic", "synthetic-anthropic");
  const incompatibleRejected = (await getEmbeddingApiKey(userId)) === null;
  await seed("openai", "__cli_oauth__:synthetic");
  await seed("openai", "synthetic-openai");
  const selected = await getEmbeddingApiKey(userId);
  result = {
    incompatibleRejected,
    selectedApiKey: selected?.apiKey === "synthetic-openai",
    baseUrl: selected?.baseUrl,
  };
}
await writeFile(path.join(root, "result.json"), JSON.stringify(result));
client.close();
