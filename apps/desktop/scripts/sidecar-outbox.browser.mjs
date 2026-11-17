/** Isolated IndexedDB regressions. Run: node apps/desktop/scripts/sidecar-outbox.browser.mjs */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportFile =
  process.env.OPENHORN_OUTBOX_REPORT || path.join(tmpdir(), "openhorn-sidecar-outbox-browser.json");
const runId = randomUUID();
const checks = [];
const errors = [];
const external = [];
const requestedPaths = [];
const started = Date.now();
const server = await createServer({
  root: desktop,
  configFile: false,
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { port: 0, host: "127.0.0.1", fs: { allow: [path.resolve(desktop, "../..")] } },
});
server.middlewares.use((request, response, next) => {
  if (request.url !== "/__sidecar_outbox_test__") return next();
  response.setHeader("Content-Type", "text/html");
  response.end('<!doctype html><meta charset="utf-8"><title>Isolated save outbox test</title>');
});
let browser;
let failure;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string", "isolated Vite server needs a port");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const context = await browser.newContext();
  await context.route("**/*", (route) => {
    const url = route.request().url();
    requestedPaths.push(new URL(url).pathname);
    if (new URL(url).origin === origin) return route.continue();
    external.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/__sidecar_outbox_test__`);
  async function initialize() {
    await page.evaluate(async (id) => {
      const module = await import("/src/lib/sidecarOutbox.ts");
      const scope = { backend: "https://fixture.invalid", userId: "fixture-user-a" };
      function record(label = "one", sequence = 1, savedScope = scope, conversationId = "conv-a") {
        const userId = `user-${label}`;
        const assistantId = `assistant-${label}`;
        const content = "Original UTF-8: 中文 😀\nNUL:\u0000 End";
        const agentRun = {
          status: "completed",
          summary: "",
          steps: [{ type: "text", content }],
        };
        const message = (messageId, role) => ({
          id: messageId,
          role,
          content,
          mode: "agent",
          conversationId,
          createdAt: new Date("2026-11-06T00:00:00.123Z"),
          ...(role === "assistant" ? { agentRun } : {}),
        });
        return {
          version: 1,
          scope: savedScope,
          payload: {
            conversationId,
            userMessageId: userId,
            assistantMessageId: assistantId,
            userContent: content,
            assistantContent: content,
            agentRun,
            model: "fixture",
            syncRevision: { sessionId: "10000000-0000-4000-8000-000000000001", sequence },
          },
          user: message(userId, "user"),
          assistant: message(assistantId, "assistant"),
          queuedAt: 1000 + sequence,
        };
      }
      async function rawTransaction(name, mode, work) {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const tx = db.transaction("pending-saves", mode);
            let value;
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
            work(tx.objectStore("pending-saves"), (result) => {
              value = result;
            });
          });
        } finally {
          db.close();
        }
      }
      async function committed(operation) {
        const trace = [];
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
          const tx = original.apply(this, args);
          if (args[1] === "readwrite")
            tx.addEventListener("complete", () => trace.push("committed"));
          return tx;
        };
        try {
          await operation();
          trace.push("resolved");
          return trace;
        } finally {
          IDBDatabase.prototype.transaction = original;
        }
      }
      window.outboxFixture = {
        ...module,
        scope,
        record,
        rawTransaction,
        committed,
        name: (label) => `openhorn-outbox-browser-${id}-${label}`,
      };
    }, runId);
  }
  await initialize();
  async function check(name, operation) {
    const before = Date.now();
    try {
      await operation();
      checks.push({ name, passed: true, elapsedMs: Date.now() - before });
      console.log(`PASS ${name}`);
    } catch (error) {
      checks.push({ name, passed: false, elapsedMs: Date.now() - before, error: String(error) });
      throw error;
    }
  }

  await check(
    "real IndexedDB survives page reload with exact Date and UTF-8 payload bytes",
    async () => {
      await page.evaluate(async () => {
        const f = window.outboxFixture;
        await f.createIndexedDbOutbox(f.name("reload")).put(f.record());
      });
      await page.reload();
      await initialize();
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const rows = await f.createIndexedDbOutbox(f.name("reload")).list(f.scope);
        const expected = f.record();
        return {
          count: rows.length,
          date: rows[0].assistant.createdAt instanceof Date,
          timestamp: rows[0].assistant.createdAt.toISOString(),
          bytes: [...new TextEncoder().encode(rows[0].payload.assistantContent)],
          expectedBytes: [...new TextEncoder().encode(expected.payload.assistantContent)],
          revision: rows[0].payload.syncRevision,
        };
      });
      assert.equal(result.count, 1);
      assert.equal(result.date, true);
      assert.equal(result.timestamp, "2026-11-06T00:00:00.123Z");
      assert.deepEqual(result.bytes, result.expectedBytes);
      assert.deepEqual(result.revision, {
        sessionId: "10000000-0000-4000-8000-000000000001",
        sequence: 1,
      });
    },
  );

  await check("backend and user scopes isolate records with the same message IDs", async () => {
    const counts = await page.evaluate(async () => {
      const f = window.outboxFixture;
      const box = f.createIndexedDbOutbox(f.name("scope"));
      const scopes = [
        f.scope,
        { ...f.scope, userId: "fixture-user-b" },
        { ...f.scope, backend: "https://other.invalid" },
      ];
      for (const scope of scopes) await box.put(f.record("same", 1, scope));
      return Promise.all(
        scopes.map(async (scope) => {
          const rows = await box.list(scope);
          return { count: rows.length, scope: rows[0].scope };
        }),
      );
    });
    assert.deepEqual(counts, [
      { count: 1, scope: { backend: "https://fixture.invalid", userId: "fixture-user-a" } },
      { count: 1, scope: { backend: "https://fixture.invalid", userId: "fixture-user-b" } },
      { count: 1, scope: { backend: "https://other.invalid", userId: "fixture-user-a" } },
    ]);
  });

  await check("old ACK removal cannot delete a newer revision in another connection", async () => {
    const result = await page.evaluate(async () => {
      const f = window.outboxFixture;
      const box = f.createIndexedDbOutbox(f.name("revision"));
      const other = f.createIndexedDbOutbox(f.name("revision"));
      const old = f.record("same", 1);
      const newer = f.record("same", 2);
      await box.put(old);
      await box.put(newer);
      const trace = await f.committed(() => other.remove(old));
      const remaining = await box.list(f.scope);
      await other.remove(newer);
      return {
        trace,
        sequences: remaining.map((row) => row.payload.syncRevision.sequence),
        empty: (await box.list(f.scope)).length,
      };
    });
    assert.deepEqual(result.trace, ["committed", "resolved"]);
    assert.deepEqual(result.sequences, [2]);
    assert.equal(result.empty, 0);
  });

  await check(
    "message, conversation and scope invalidations resolve only after transaction commit",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const box = f.createIndexedDbOutbox(f.name("invalidate"));
        const reader = f.createIndexedDbOutbox(f.name("invalidate"));
        const otherScope = { ...f.scope, userId: "fixture-user-b" };
        const one = f.record("one");
        const two = f.record("two");
        await box.put(one);
        await box.put(two);
        await box.put(f.record("other-conv", 1, f.scope, "conv-b"));
        await box.put(f.record("other-user", 1, otherScope));
        const traces = [];
        traces.push(await f.committed(() => box.invalidate(f.scope, { messageId: one.user.id })));
        const afterUser = (await reader.list(f.scope)).map((row) => row.assistant.id).sort();
        traces.push(
          await f.committed(() => box.invalidate(f.scope, { messageId: two.assistant.id })),
        );
        const afterAssistant = (await reader.list(f.scope)).map((row) => row.assistant.id);
        await box.put(one);
        await box.put(two);
        traces.push(await f.committed(() => box.invalidate(f.scope, { conversationId: "conv-a" })));
        const afterConversation = (await reader.list(f.scope)).map((row) => row.assistant.id);
        traces.push(await f.committed(() => box.clear(f.scope)));
        return {
          traces,
          afterUser,
          afterAssistant,
          afterConversation,
          empty: (await reader.list(f.scope)).length,
          other: (await reader.list(otherScope)).length,
        };
      });
      for (const trace of result.traces) assert.deepEqual(trace, ["committed", "resolved"]);
      assert.deepEqual(result.afterUser, ["assistant-other-conv", "assistant-two"]);
      assert.deepEqual(result.afterAssistant, ["assistant-other-conv"]);
      assert.deepEqual(result.afterConversation, ["assistant-other-conv"]);
      assert.equal(result.empty, 0);
      assert.equal(result.other, 1);
    },
  );

  await check(
    "malformed, unknown-version and missing-ID writes reject without persisting",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const box = f.createIndexedDbOutbox(f.name("invalid"));
        const variants = [
          (row) => {
            row.version = 99;
          },
          (row) => {
            delete row.user.id;
            delete row.payload.userMessageId;
          },
          (row) => {
            delete row.assistant.id;
            delete row.payload.assistantMessageId;
          },
          (row) => {
            row.assistant.id = row.user.id;
            row.payload.assistantMessageId = row.user.id;
          },
          (row) => {
            row.payload.syncRevision.sessionId = "invalid";
          },
          (row) => {
            row.payload.syncRevision.sequence = 0;
          },
          (row) => {
            row.user.createdAt = row.user.createdAt.toISOString();
          },
          (row) => {
            row.payload.conversationId = "";
          },
          (row) => {
            row.payload.newAssistantMessageId = "another";
          },
          (row) => {
            row.scope = null;
          },
          (row) => {
            row.payload.expectedUserToken = "";
          },
          (row) => {
            row.payload.expectedAssistantToken = 42;
          },
        ];
        const rejected = [];
        for (const mutate of variants) {
          const row = f.record();
          mutate(row);
          try {
            await box.put(row);
            rejected.push(false);
          } catch {
            rejected.push(true);
          }
        }
        return { rejected, count: (await box.list(f.scope)).length };
      });
      assert.equal(result.rejected.length, 12);
      assert.equal(result.rejected.every(Boolean), true);
      assert.equal(result.count, 0);
    },
  );

  await check(
    "persisted corruption rejects recovery without silently deleting either record",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const name = f.name("corrupt");
        const box = f.createIndexedDbOutbox(name);
        await box.put(f.record());
        await f.rawTransaction(name, "readwrite", (store) =>
          store.put({ key: "corrupt-fixture", record: { version: 99 } }),
        );
        let rejected = false;
        try {
          await box.list(f.scope);
        } catch {
          rejected = true;
        }
        const count = await f.rawTransaction(name, "readonly", (store, done) => {
          const request = store.count();
          request.onsuccess = () => done(request.result);
        });
        await f.rawTransaction(name, "readwrite", (store) => store.delete("corrupt-fixture"));
        return { rejected, count, valid: (await box.list(f.scope)).length };
      });
      assert.deepEqual(result, { rejected: true, count: 2, valid: 1 });
    },
  );

  await check(
    "record limit rejects new saves without eviction while existing revisions can update",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const box = f.createIndexedDbOutbox(f.name("count-limit"));
        for (let i = 0; i < 200; i++) await box.put(f.record(`row-${i}`));
        let rejected = false;
        try {
          await box.put(f.record("overflow"));
        } catch {
          rejected = true;
        }
        await box.put(f.record("row-0", 2));
        const rows = await box.list(f.scope);
        return {
          rejected,
          count: rows.length,
          originalLast: rows.some((row) => row.assistant.id === "assistant-row-199"),
          firstSequence: rows.find((row) => row.assistant.id === "assistant-row-0").payload
            .syncRevision.sequence,
        };
      });
      assert.deepEqual(result, {
        rejected: true,
        count: 200,
        originalLast: true,
        firstSequence: 2,
      });
    },
  );

  await check(
    "UTF-8 byte limit rejects oversized data and preserves previous unsaved records",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const box = f.createIndexedDbOutbox(f.name("byte-limit"));
        await box.put(f.record("keep"));
        const huge = f.record("huge");
        const text = "界".repeat(9 * 1024 * 1024);
        huge.payload.assistantContent = text;
        huge.assistant.content = text;
        let rejected = false;
        try {
          await box.put(huge);
        } catch {
          rejected = true;
        }
        const rows = await box.list(f.scope);
        return { rejected, ids: rows.map((row) => row.assistant.id) };
      });
      assert.deepEqual(result, { rejected: true, ids: ["assistant-keep"] });
    },
  );

  await check(
    "unavailable IndexedDB rejects clearly and a later restored storage can retry",
    async () => {
      const result = await page.evaluate(async () => {
        const f = window.outboxFixture;
        const descriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
        const box = f.createIndexedDbOutbox(f.name("unavailable"));
        let error = "";
        try {
          Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
          try {
            await box.put(f.record());
          } catch (failure) {
            error = String(failure);
          }
        } finally {
          if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
          else delete window.indexedDB;
        }
        await box.put(f.record());
        return { error, count: (await box.list(f.scope)).length };
      });
      assert.match(result.error, /unavailable/);
      assert.equal(result.count, 1);
    },
  );

  assert.equal(
    requestedPaths.some((value) => /^\/src\/(App|main)\./.test(value)),
    false,
    "main app must never load",
  );
  assert.deepEqual(errors, [], "unexpected browser errors");
  assert.deepEqual(external, [], "isolated fixture must not make external requests");
  console.log("Real IndexedDB sidecar outbox regressions passed.");
} catch (error) {
  failure = error;
} finally {
  const report = {
    observedAt: new Date().toISOString(),
    browser: browser ? await browser.version() : null,
    passed: !failure,
    elapsedMs: Date.now() - started,
    checks,
    browserErrors: errors,
    blockedExternalRequests: external,
    requestedPaths: [...new Set(requestedPaths)],
    ...(failure ? { error: String(failure) } : {}),
  };
  try {
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report: ${reportFile}`);
  } finally {
    await browser?.close();
    await server.close();
  }
}
if (failure) throw failure;
