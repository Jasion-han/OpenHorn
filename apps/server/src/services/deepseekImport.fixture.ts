import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImportResult } from "./importService";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-deepseek-import-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
process.env.OPENHORN_DATA_DIR = directory;
const { client } = await import("../db");

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function zip(name: string, entries: [string, unknown][]) {
  const locals: Buffer[] = [],
    centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const crc = crc32(data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    centrals.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  const file = path.join(directory, `${name}.zip`);
  await writeFile(file, Buffer.concat([...locals, ...centrals, end]));
  return file;
}

const at = (seconds: number) => new Date((1700000000 + seconds) * 1000).toISOString();
function session(id: string) {
  const message = (id: number, parent_id: number | null, role: string, fragments: unknown[]) => ({
    id,
    parent_id,
    role,
    fragments,
    status: "FINISHED",
    thinking_enabled: true,
    search_enabled: true,
    accumulated_token_usage: 0,
    inserted_at: at(id),
  });
  return {
    id,
    title: "Current branch",
    pinned: false,
    current_message_id: 2,
    inserted_at: at(0),
    updated_at: at(60),
    messages: [
      message(1, null, "USER", [
        { type: "REQUEST", content: "hello " },
        { type: "REQUEST", content: "world" },
        {
          type: "FILE",
          files: [
            {
              id: "missing-file",
              file_name: "lost.pdf",
              file_size: 20,
              token_usage: null,
              inserted_at: at(1),
              export_path: null,
              is_image: false,
              width: null,
              height: null,
            },
          ],
        },
      ]),
      message(2, 1, "ASSISTANT", [
        { type: "THINK", content: "careful thought", elapsed_secs: 2 },
        { type: "RESPONSE", content: "first\n" },
        {
          type: "TOOL_SEARCH",
          queries: ["query"],
          status: "FINISHED",
          results: [
            {
              url: "https://example.com/source",
              title: "Source",
              snippet: "evidence",
              published_at: null,
              site_name: null,
            },
          ],
        },
        { type: "RESPONSE", content: "last" },
      ]),
      message(3, 1, "ASSISTANT", [{ type: "RESPONSE", content: "unselected" }]),
      message(4, 2, "USER", [{ type: "REQUEST", content: "beyond current cursor" }]),
    ],
  };
}
type Session = ReturnType<typeof session>;
function archive(files: Session[]): [string, unknown][] {
  return [
    ["manifest.json", { export_format_version: 3 }],
    ["user.json", { apiKey: "synthetic-do-not-import", config: { surprise: true } }],
    ...files.map((s): [string, unknown] => [`chat_sessions/${s.id}.json`, s]),
    [
      "chat_session_index.json",
      files.map((s) => ({
        id: s.id,
        title: s.title,
        pinned: false,
        message_count: s.messages.length,
        inserted_at: s.inserted_at,
        updated_at: s.updated_at,
      })),
    ],
  ];
}

try {
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase({ backup: null });
  const { Hono } = await import("hono");
  const { default: routes } = await import("../routes/dataTransfer");
  const services = await import("./importService");
  const { getImportRecord } = await import("./importRecordsService");
  const app = new Hono().route("/data", routes);
  const userId = String((await client.execute("SELECT id FROM users LIMIT 1")).rows[0].id);
  async function request(filePath: string, format?: string) {
    const res = await app.request("/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath, format }),
    });
    return { status: res.status, body: (await res.json()) as ImportResult };
  }
  const deepseek = await zip("deepseek", archive([session("source-session")]));
  const openhorn = await zip("openhorn", [
    [
      "manifest.json",
      {
        formatVersion: "1.3.0",
        exportedAt: at(0),
        appVersion: "test",
        contents: {},
      },
    ],
  ]);
  const bogus = await zip("bogus", [["manifest.json", {}]]);
  const version = await zip("version", [["manifest.json", { formatVersion: "999", contents: {} }]]);
  const malformed = await zip("malformed", [["manifest.json", Buffer.from("{broken")]]);
  const hybrid = await zip("hybrid", [
    [
      "manifest.json",
      {
        export_format_version: 3,
        formatVersion: "1.3.0",
        exportedAt: at(0),
        appVersion: "x",
        contents: {},
      },
    ],
  ]);
  const chatgpt = path.join(directory, "chatgpt.json"),
    claude = path.join(directory, "claude.json");
  await writeFile(chatgpt, JSON.stringify([{ mapping: {}, current_node: "x" }]));
  await writeFile(claude, JSON.stringify([{ chat_messages: [] }]));
  const detection: Record<string, string> = {};
  for (const [name, file] of Object.entries({
    deepseek,
    openhorn,
    bogus,
    version,
    malformed,
    hybrid,
    chatgpt,
    claude,
  })) {
    detection[name] = await services.detectFormat(file).catch(() => "threw");
  }
  const first = await request(deepseek);
  const saved = (
    await client.execute({
      sql: "SELECT * FROM conversations WHERE user_id=? ORDER BY created_at",
      args: [userId],
    })
  ).rows[0];
  const savedMessages = saved
    ? (
        await client.execute({
          sql: "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at",
          args: [saved.id],
        })
      ).rows
    : [];
  const steps = savedMessages[1]?.agent_run
    ? JSON.parse(String(savedMessages[1].agent_run)).steps
    : null;
  const history = first.body.recordId ? await getImportRecord(userId, first.body.recordId) : null;
  const again = await request(deepseek);
  if (saved)
    await client.execute({
      sql: "UPDATE conversations SET title='Locally edited' WHERE id=?",
      args: [saved.id],
    });
  const edited = session("source-session");
  edited.title = "New export title";
  const changed = await request(await zip("changed", archive([edited])));
  const editedTitle = saved
    ? (
        await client.execute({
          sql: "SELECT title FROM conversations WHERE id=?",
          args: [saved.id],
        })
      ).rows[0]?.title
    : null;
  const parallel = await zip("parallel", archive([session("parallel")]));
  const concurrent = await Promise.all([request(parallel), request(parallel)]);
  const concurrentRows = Number(
    (await client.execute("SELECT count(*) n FROM conversations WHERE title='Current branch'"))
      .rows[0].n,
  );
  await client.execute(
    "INSERT INTO users(id,email,username,password_hash,created_at,updated_at) VALUES('other','other@test.local','Other','x',1,1)",
  );
  const otherUser =
    "importDeepSeek" in services ? await services.importDeepSeek("other", deepseek) : null;
  const otherIdentity = (await client.execute("SELECT id FROM conversations WHERE user_id='other'"))
    .rows[0]?.id;
  const otherHistoryInvisible = first.body.recordId
    ? (await getImportRecord("other", first.body.recordId)) === null
    : false;

  const beforeInvalid = Number(
    (await client.execute("SELECT count(*) n FROM conversations")).rows[0].n,
  );
  const invalid: unknown[] = [];
  for (const kind of [
    "version",
    "missing-index",
    "duplicate-index",
    "missing-session",
    "count",
    "parent",
    "cycle",
    "role",
    "root",
    "cursor",
    "id",
    "date",
    "fragment",
    "duplicate-entry",
    "path",
  ]) {
    const good = session(`good-${kind}`),
      bad = session(`bad-${kind}`);
    const entries = archive([good, bad]);
    if (kind === "version") entries[0][1] = { export_format_version: "3" };
    if (kind === "missing-index") entries.pop();
    if (kind === "duplicate-index")
      (entries.at(-1)?.[1] as unknown[]).push((entries.at(-1)?.[1] as unknown[])[0]);
    if (kind === "missing-session") entries.splice(3, 1);
    if (kind === "count") (entries.at(-1)?.[1] as Record<string, unknown>[])[1].message_count = 999;
    if (kind === "parent") bad.messages[3].parent_id = 999;
    if (kind === "cycle") bad.messages[0].parent_id = 4;
    if (kind === "role") bad.messages[1].role = "USER";
    if (kind === "root") bad.messages[0].role = "ASSISTANT";
    if (kind === "cursor") bad.current_message_id = 999;
    if (kind === "id") bad.messages[1].id = 1;
    if (kind === "date") bad.updated_at = "2026-02-31T00:00:00Z";
    if (kind === "fragment") bad.messages[1].fragments = [{ type: "RESPONSE", content: 123 }];
    if (kind === "duplicate-entry") entries.push(entries[2]);
    if (kind === "path")
      bad.messages[0].fragments = [
        {
          type: "FILE",
          files: [
            {
              id: "bad",
              file_name: "escape.png",
              file_size: 1,
              token_usage: null,
              inserted_at: at(1),
              export_path: "chat_sessions/another_files/escape.png",
              is_image: true,
              width: 1,
              height: 1,
            },
          ],
        },
      ];
    const result = await request(await zip(`invalid-${kind}`, entries), "deepseek");
    // Each invalid archive contains a fresh valid session first: nothing from it may leak.
    const count = Number((await client.execute("SELECT count(*) n FROM conversations")).rows[0].n);
    invalid.push({
      kind,
      imported: result.body.conversations?.imported ?? 0,
      hasError: result.status === 400 || result.body.errors?.length > 0,
      rows: count - beforeInvalid,
    });
  }
  const forgedZip = await zip("forged", [
    ["manifest.json", {}],
    [
      "conversations.json",
      [
        {
          id: "forged-id",
          title: "forged",
          contextLength: 4096,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    ],
  ]);
  const forged = await Promise.all([
    request(deepseek, "openhorn"),
    request(deepseek, "chatgpt"),
    request(deepseek, "claude"),
    request(forgedZip, "openhorn"),
  ]);
  const directBackup = await services.importOpenHornBackup(userId, forgedZip);
  const forgedRows = Number(
    (await client.execute("SELECT count(*) n FROM conversations WHERE id='forged-id'")).rows[0].n,
  );
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const rollbackSession = session("rollback");
  rollbackSession.title = "Rollback";
  const image = {
    id: "image",
    file_name: "../../original.png",
    file_size: imageBytes.length,
    token_usage: null,
    inserted_at: at(1),
    export_path: "chat_sessions/rollback_files/original.png",
    is_image: true,
    width: 1,
    height: 1,
  };
  rollbackSession.messages[0].fragments = [
    { type: "REQUEST", content: "image prompt" },
    { type: "FILE", files: [image] },
  ];
  const rollbackZip = await zip("rollback", [
    ...archive([rollbackSession]),
    [image.export_path, imageBytes],
  ]);
  await client.execute(
    "CREATE TRIGGER reject_deepseek_message BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'synthetic SQL failure'); END",
  );
  const failed = await request(rollbackZip);
  const failedRows = Number(
    (await client.execute("SELECT count(*) n FROM conversations WHERE title='Rollback'")).rows[0].n,
  );
  const failedMessages = Number(
    (
      await client.execute(
        "SELECT count(*) n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE title='Rollback')",
      )
    ).rows[0].n,
  );
  const failedFiles = (await readdir(path.join(directory, "uploads")).catch(() => [])).length;
  await client.execute("DROP TRIGGER reject_deepseek_message");
  const retried = await request(rollbackZip);
  const imageRow = (await client.execute("SELECT * FROM attachments LIMIT 1")).rows[0];
  const restoredImage = imageRow
    ? (await readFile(String(imageRow.file_path))).equals(imageBytes)
    : false;
  const imagePathBounded = imageRow
    ? String(imageRow.file_path).startsWith(path.join(directory, "uploads", "deepseek-"))
    : false;
  const imageMessage = imageRow
    ? (
        await client.execute({
          sql: "SELECT attachments FROM messages WHERE id=?",
          args: [imageRow.message_id],
        })
      ).rows[0]
    : null;
  const imageLinked = imageMessage
    ? JSON.parse(String(imageMessage.attachments))[0] === imageRow.id
    : false;
  const noConfigImported =
    (await client.execute("SELECT count(*) n FROM settings")).rows[0].n === 0 &&
    (await client.execute("SELECT count(*) n FROM channels")).rows[0].n === 0;
  const attachmentRows = Number(
    (
      await client.execute(
        "SELECT count(*) n FROM attachments WHERE conversation_id != (SELECT id FROM conversations WHERE title='Rollback')",
      )
    ).rows[0].n,
  );
  // A fresh process proves the dedupe key lives in SQLite, not an in-memory set.
  const restart = Bun.spawnSync(
    [
      process.execPath,
      new URL("./deepseekImport.worker.fixture.ts", import.meta.url).pathname,
      userId,
      deepseek,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    },
  );
  const restarted =
    restart.exitCode === 0
      ? JSON.parse(restart.stdout.toString().trim().split("\n").at(-1) ?? "null")
      : null;
  const processZip = await zip("cross-process", archive([session("cross-process")]));
  // Release the observing connection before independent server processes write.
  client.close();
  const workers = [0, 1].map(() =>
    Bun.spawn(
      [
        process.execPath,
        new URL("./deepseekImport.worker.fixture.ts", import.meta.url).pathname,
        userId,
        processZip,
      ],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    ),
  );
  const crossProcess = await Promise.all(
    workers.map(async (worker) => {
      const [code, stdout, stderr] = await Promise.all([
        worker.exited,
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
      ]);
      if (code !== 0) throw new Error(stderr);
      return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    }),
  );
  const lockedZip = await zip("locked", archive([session("locked")]));
  const { createClient } = await import("@libsql/client");
  const lockingClient = createClient({ url: process.env.DATABASE_URL });
  const lock = await lockingClient.transaction("write");
  const lockedWorker = Bun.spawn(
    [
      process.execPath,
      new URL("./deepseekImport.worker.fixture.ts", import.meta.url).pathname,
      userId,
      lockedZip,
    ],
    { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await lock.commit();
  lock.close();
  lockingClient.close();
  const lockedOutput = await new Response(lockedWorker.stdout).text();
  const lockedCode = await lockedWorker.exited;
  const locked =
    lockedCode === 0 ? JSON.parse(lockedOutput.trim().split("\n").at(-1) ?? "null") : null;
  console.log(
    JSON.stringify({
      detection,
      first,
      saved,
      savedMessages,
      steps,
      history,
      again,
      changed,
      editedTitle,
      concurrent,
      concurrentRows,
      otherUser,
      otherIdentity,
      otherHistoryInvisible,
      invalid,
      forged,
      directBackup,
      forgedRows,
      failed,
      failedRows,
      failedMessages,
      failedFiles,
      retried,
      noConfigImported,
      attachmentRows,
      restarted,
      restoredImage,
      imagePathBounded,
      imageLinked,
      crossProcess,
      locked,
    }),
  );
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
