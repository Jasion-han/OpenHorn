/** Real composer/send/error/retry paths with a local DB API and fake sidecar. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const files = new Map();
const requests = [];
const rows = [];
const pendingResponses = new Set();
let prepares = 0;
let completes = 0;
let retries = 0;
let holdComplete = null;
let holdSettings = null;
let holdAgentSave = null;
let syncedPreparations = 0;
let failAgentSaveOnce = false;
let retryMode = "success";
let truncationEdit = false;
let budgetPrepare = false;
let protocol = "openai";
const conversation = {
  id: "failure-conversation",
  title: "Failure regression",
  channelId: "fixture-channel",
  modelId: "fixture-model",
  contextLength: 4096,
  defaultMode: "chat",
  lastMode: "chat",
  forceWebSearch: false,
  isPinned: false,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const retryText =
  '```openui-lang\nroot=Input($amount,"Retry amount","number")\n$amount=11\n```\n\nRetry complete.';
const retryPartial =
  '```openui-lang\nroot=Input($amount,"Partial retry","number")\n$amount=9\n```\n\nRetry partial.';
const truncationPartial = '```openui-lang\nroot=Input($value,"Truncated UI")\n$value="unfinished"';
const truncationUsage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
const json = (response, value, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
const server = http.createServer(async (request, response) => {
  pendingResponses.add(response);
  const finished = () => pendingResponses.delete(response);
  response.once("finish", finished);
  response.once("close", finished);
  const url = new URL(request.url, "http://fixture");
  const path = url.pathname;
  if (files.has(path)) {
    response.setHeader(
      "Content-Type",
      path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
    );
    response.end(files.get(path));
    return;
  }
  if (path === "/") {
    response.end(
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}#root{width:1100px}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.h-full{height:100%}.overflow-y-auto{overflow-y:auto}button{min-height:24px}textarea{min-height:36px}</style><div id="root"></div><script src="/fixture.js"></script>',
    );
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const data = body ? JSON.parse(body) : {};
  requests.push({ method: request.method, path, data });
  if (path === "/conversations")
    return json(response, {
      conversations: [conversation, { ...conversation, id: "other-conversation" }],
    });
  if (path === "/messages" || /^\/messages\/(?:failure|other)-conversation$/.test(path))
    return json(response, {
      messages: rows.filter(
        (row) => path === "/messages" || row.conversationId === path.split("/")[2],
      ),
    });
  if (path === "/settings/search-status")
    return json(response, { configured: false, source: "none" });
  if (path === "/settings") {
    if (holdSettings && url.searchParams.get("keys")?.includes("chat.systemPrompt")) {
      const held = holdSettings;
      holdSettings = null;
      await held;
    }
    return json(response, { settings: { "prompts.templates": "[]" } });
  }
  if (path === "/mcp/servers") return json(response, { servers: [] });
  if (path === "/channels/fixture-channel/credentials")
    return json(response, {
      credentials: {
        apiKey: "fixture-only",
        baseUrl: null,
        modelId: "fixture-model",
        protocol,
      },
    });
  if (path === "/messages/chat/prepare") {
    prepares++;
    const userMessageId = `saved-user-${prepares}`;
    const assistantMessageId = `saved-assistant-${prepares}`;
    rows.push(
      ...[
        [userMessageId, "user", data.content],
        [assistantMessageId, "assistant", ""],
      ].map(([id, role, content]) => ({
        id,
        conversationId: data.conversationId,
        role,
        content,
        mode: "chat",
        createdAt: new Date().toISOString(),
      })),
    );
    if (budgetPrepare) {
      rows.at(-1).finishReason = "context_budget_exceeded";
      return json(
        response,
        {
          error: "fixture estimated context budget",
          code: "chat_context_budget_exceeded",
          userMessageId,
          assistantMessageId,
        },
        400,
      );
    }
    return json(response, {
      userMessageId,
      assistantMessageId,
      apiKey: "fixture-only",
      baseUrl: "http://fixture.invalid",
      saveToken: "fixture-prepared-snapshot",
      protocol,
      model: "fixture-model",
      messages: [{ role: "user", content: data.content }],
    });
  }
  if (path === "/messages/chat/complete") {
    assert.equal(data.saveToken, "fixture-prepared-snapshot");
    completes++;
    const held = holdComplete;
    holdComplete = null;
    if (held) {
      await held.promise;
      if (held.reject) return json(response, { error: "fixture old save failed" }, 500);
    }
    const row = rows.find((row) => row.id === data.assistantMessageId);
    assert.ok(row, "completion must use the persisted assistant ID");
    Object.assign(row, {
      content: data.content,
      finishReason: data.finishReason ?? null,
      usage: data.usage ? JSON.stringify(data.usage) : null,
      updatedAt: new Date().toISOString(),
    });
    return json(response, { success: true });
  }
  if (path === "/messages/sync-sidecar") {
    syncedPreparations++;
    server.emit("fixture-agent-save-observed");
    if (failAgentSaveOnce) {
      failAgentSaveOnce = false;
      return json(response, { error: "fixture save is unavailable" }, 500);
    }
    const held = holdAgentSave;
    holdAgentSave = null;
    if (held) {
      server.emit("fixture-agent-save-started", data);
      await held;
    }
    const userMessageId = data.userMessageId ?? `prepared-user-${syncedPreparations}`;
    const assistantMessageId =
      data.assistantMessageId ??
      data.newAssistantMessageId ??
      `prepared-assistant-${syncedPreparations}`;
    for (const [id, role, content] of [
      [userMessageId, "user", data.userContent],
      [assistantMessageId, "assistant", data.assistantContent],
    ]) {
      const values = {
        id,
        conversationId: conversation.id,
        role,
        content,
        mode: "agent",
        ...(role === "assistant"
          ? { agentRun: data.agentRun, finishReason: data.finishReason }
          : {}),
        createdAt: new Date().toISOString(),
      };
      const existing = rows.find((row) => row.id === id);
      if (existing) Object.assign(existing, values);
      else rows.push(values);
    }
    return json(response, { userMessageId, assistantMessageId });
  }
  if (/^\/messages\/[^/]+\/regenerate$/.test(path)) {
    retries++;
    const id = decodeURIComponent(path.split("/")[2]);
    const row = rows.find((row) => row.id === id);
    assert.ok(row, "retry must use the persisted assistant ID");
    const truncated = retryMode.startsWith("truncated-");
    const generated =
      retryMode === "truncated-partial"
        ? truncationPartial
        : retryMode === "success"
          ? retryText
          : retryMode === "partial-error"
            ? retryPartial
            : "";
    if (generated) {
      Object.assign(row, {
        content: generated,
        finishReason: truncated ? "length" : retryMode === "partial-error" ? "error" : null,
        usage: truncated ? JSON.stringify(truncationUsage) : null,
      });
    }
    if (retryMode === "refused") Object.assign(row, { content: "", finishReason: "refused" });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const terminal = truncated
      ? {
          type: "error",
          message: "fixture raw retry output limit",
          content: generated,
          errorCode: "response_truncated",
          usage: truncationUsage,
          messageId: id,
          model: "fixture-model",
        }
      : retryMode === "success"
        ? { type: "done", messageId: id, model: "fixture-model" }
        : {
            type: "error",
            message: "fixture retry interrupted",
            ...(retryMode === "refused" ? { content: "", errorCode: "response_refused" } : {}),
            messageId: id,
            model: "fixture-model",
          };
    response.end(
      [...(generated ? [{ type: "delta", content: generated }] : []), terminal]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    return;
  }
  if (/^\/messages\/[^/]+\/edit$/.test(path)) {
    const user = rows.find((row) => row.id === decodeURIComponent(path.split("/")[2]));
    assert.ok(user);
    user.content = data.content;
    const id = "saved-edited-tail";
    const generated = truncationEdit ? truncationPartial : retryPartial;
    rows.push({
      id,
      conversationId: conversation.id,
      role: "assistant",
      content: generated,
      ...(truncationEdit
        ? { finishReason: "length", usage: JSON.stringify(truncationUsage) }
        : { finishReason: "error" }),
      mode: "chat",
      createdAt: new Date().toISOString(),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      [
        { type: "delta", content: generated },
        {
          type: "error",
          message: truncationEdit ? "fixture raw edit output limit" : "fixture edit interrupted",
          ...(truncationEdit ? { errorCode: "response_truncated", usage: truncationUsage } : {}),
          messageId: id,
          model: "fixture-model",
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    );
    return;
  }
  json(response, { error: `Unexpected fixture request: ${request.method} ${path}` }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bundle = await build({
    stdin: {
      contents: await readFile(resolve(desktop, "scripts/fixtures/genui-chat-failure.tsx"), "utf8"),
      loader: "tsx",
      resolveDir: resolve(desktop, "scripts/fixtures"),
    },
    bundle: true,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify({ VITE_API_BASE: origin }),
    },
    write: false,
    outfile: "/fixture.js",
    logLevel: "silent",
  });
  for (const file of bundle.outputFiles) files.set(`/${file.path.split("/").pop()}`, file.text);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  // All network activity belongs to this disposable API server.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  await page.waitForFunction(() => !!window.failureChat);
  const snapshot = () => page.evaluate(() => window.failureChat.snapshot());
  const reset = async () => {
    // Discard this scenario's durable work before reusing backend message IDs.
    await page.evaluate(() => window.failureChat.clearForScenario());
    await Promise.all(
      [...pendingResponses].map(
        (response) =>
          new Promise((resolve) => {
            response.once("finish", resolve);
            response.once("close", resolve);
          }),
      ),
    );
    rows.length = 0;
    prepares = 0;
    completes = 0;
    retries = 0;
    retryMode = "success";
    truncationEdit = false;
    budgetPrepare = false;
    syncedPreparations = 0;
    failAgentSaveOnce = false;
    protocol = "openai";
    // A finished HTTP request can still have application continuations queued.
    // Reusing the realm and the same message IDs would let a previous case's
    // late history reload repopulate the next case after store.reset(). A new
    // document gives each scenario independent stores and pending promises;
    // remounts and races being tested inside a scenario still share one realm.
    await page.reload();
    await page.waitForFunction(() => !!window.failureChat);
    assert.deepEqual((await snapshot()).messages, [], "a new scenario starts without old replies");
  };
  const send = async () => {
    await page.locator("textarea").fill("test failure");
    await page.locator("textarea").press("Enter");
    await page
      .waitForFunction(() => window.failureChat.ready())
      .catch(async (error) => {
        console.error("Fixture send state", JSON.stringify(await snapshot()));
        console.error(
          "Fixture request paths",
          requests.slice(-8).map((request) => request.path),
        );
        throw error;
      });
  };
  const emit = (content) => page.evaluate((content) => window.failureChat.emit(content), content);
  const fail = async () => {
    await page.evaluate(() => window.failureChat.fail());
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  };
  const closed =
    '```openui-lang\nroot=Input($amount,"Persist amount","number")\n$amount=5\n```\n\nPartial reply.';
  await send();
  await emit(closed);
  const amount = page.getByRole("textbox", { name: "Persist amount", exact: true });
  await amount.fill("12");
  await amount.evaluate((node) => {
    window.originalControl = node;
  });
  await fail();
  assert.equal(await amount.inputValue(), "12", "a closed UI and its edited state survive failure");
  assert.equal(
    await amount.evaluate((node) => node === window.originalControl),
    true,
    "failure must retain the live control",
  );
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").content,
    closed,
  );
  await page.getByRole("alert").filter({ hasText: "fixture stream interrupted" }).waitFor();
  await page.waitForFunction(() =>
    window.failureChat.snapshot().messages.some((message) => message.id === "saved-assistant-1"),
  );
  assert.equal(completes, 1);
  assert.equal(rows.find((row) => row.role === "assistant").content, closed);
  await emit("late chunk must be ignored");
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").content,
    closed,
  );
  const retryLabel = await page.evaluate(() => window.failureChat.labels.retry);
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.getByRole("textbox", { name: "Retry amount", exact: true }).waitFor();
  assert.equal(retries, 1);
  assert.equal(
    await page.getByRole("textbox", { name: "Retry amount", exact: true }).inputValue(),
    "11",
  );
  assert.equal((await snapshot()).error, null);
  console.log(
    "PASS real composer send: partial/state/DB survive failure, late chunks ignored, persisted-ID retry succeeds",
  );

  retryMode = "partial-error";
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  const partialAmount = page.getByRole("textbox", { name: "Partial retry", exact: true });
  await partialAmount.waitFor();
  await page.waitForFunction(
    () => window.failureChat.snapshot().error === "fixture retry interrupted",
  );
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").content,
    retryPartial,
  );
  assert.equal(rows.find((row) => row.role === "assistant").content, retryPartial);
  await partialAmount.fill("24");
  retryMode = "empty-error";
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.waitForFunction(
    () => window.failureChat.snapshot().error === "fixture retry interrupted",
  );
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").content,
    retryPartial,
  );
  assert.equal(await partialAmount.inputValue(), "24");
  console.log(
    "PASS terminal SSE failures: partial retry survives and zero-output retry restores the preceding reply/state",
  );

  await reset();
  rows.push({
    id: "saved-user-tail",
    conversationId: conversation.id,
    role: "user",
    content: "original tail",
    mode: "chat",
    createdAt: new Date().toISOString(),
  });
  await page.evaluate(() => window.failureChat.reload());
  const editLabel = await page.evaluate(() => window.failureChat.labels.edit);
  await page.getByRole("button", { name: editLabel, exact: true }).click();
  await page.locator("textarea").first().fill("edited tail");
  await page.locator("textarea").first().press("Enter");
  await page.waitForFunction(
    () => window.failureChat.snapshot().error === "fixture edit interrupted",
  );
  const editedReply = (await snapshot()).messages.find((message) => message.role === "assistant");
  assert.equal(editedReply.id, "saved-edited-tail");
  assert.equal(editedReply.content, retryPartial);
  assert.equal(rows.find((row) => row.role === "user").content, "edited tail");
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.getByRole("textbox", { name: "Retry amount", exact: true }).waitFor();
  assert.equal(retries, 1);
  console.log(
    "PASS edited tail failure: error reconciles newly persisted reply ID and immediate retry uses that ID",
  );

  await reset();
  await send();
  await emit(closed);
  await amount.fill("12");
  await fail();
  await page.evaluate(async () => {
    await window.failureChat.reload();
    window.failureChat.remount();
  });
  assert.equal(await amount.inputValue(), "12");
  console.log(
    "PASS failed reply reload/remount retains the exact closed program and edited binding",
  );

  await reset();
  rows.push(
    {
      id: "legacy-user",
      conversationId: conversation.id,
      role: "user",
      content: "persisted question before an interrupted reply",
      mode: "chat",
      createdAt: new Date(0).toISOString(),
    },
    {
      id: "legacy-empty-assistant",
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      mode: "chat",
      createdAt: new Date(1).toISOString(),
    },
  );
  await page.evaluate(() => window.failureChat.reload());
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.getByRole("textbox", { name: "Retry amount", exact: true }).waitFor();
  assert.equal(retries, 1);
  console.log("PASS reloaded legacy empty Chat reply: the real Retry action uses its persisted ID");

  for (const rejected of [true, false]) {
    await reset();
    await send();
    await emit(closed);
    let release;
    holdComplete = {
      reject: rejected,
      promise: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const pendingSave = page.waitForRequest((request) =>
      request.url().endsWith("/messages/chat/complete"),
    );
    if (rejected) await page.evaluate(() => window.failureChat.fail());
    else await page.evaluate(() => window.failureChat.done());
    await pendingSave;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.locator("textarea").fill("second turn");
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(() => window.failureChat.snapshot().runs === 2);
    await emit('```openui-lang\nroot=Input($next,"New turn")\n$next="active"\n```\nNew partial');
    const oldSaved = page.waitForResponse((response) =>
      response.url().endsWith("/messages/chat/complete"),
    );
    release();
    await oldSaved;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const current = await snapshot();
    assert.equal(current.streaming, true, "an old save must not end the newer turn");
    assert.equal(current.loading, true, "an old finalizer must not clear the newer loading state");
    assert.equal(current.error, null, "an old failure must not become the newer turn's error");
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/messages/chat/complete"),
    );
    await page.evaluate(() => window.failureChat.done());
    await saved;
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    console.log(
      `PASS old ${rejected ? "rejected" : "successful"} save after Stop/new send cannot mutate the newer turn`,
    );
  }

  for (const kind of ["retry", "edit"]) {
    for (const rejected of [false, true]) {
      await reset();
      await send();
      await emit(closed);
      await amount.fill("12");
      await fail();
      await page.evaluate(
        ({ kind, rejected }) => {
          window.failureChat.deferRerun(kind, rejected);
          window.failureChat.remount();
        },
        { kind, rejected },
      );
      if (kind === "retry") {
        await page.getByRole("button", { name: retryLabel, exact: true }).click();
      } else {
        await page.getByRole("button", { name: editLabel, exact: true }).click();
        await page.locator("textarea").first().fill("deferred edited question");
        await page.locator("textarea").first().press("Enter");
      }
      await page.waitForFunction(() => window.failureChat.snapshot().heldRerun);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      if (kind === "retry")
        assert.equal(
          await amount.inputValue(),
          "12",
          "Stop restores a retry with no visible output",
        );
      await page.locator("textarea").fill("new turn during old rerun settlement");
      await page.locator("textarea").press("Enter");
      await page.waitForFunction(() => window.failureChat.snapshot().runs === 2);
      await emit('```openui-lang\nroot=Input($next,"New turn")\n$next="active"\n```\nNew partial');
      const newControl = page.getByRole("textbox", { name: "New turn", exact: true });
      await newControl.fill("keep newer state");
      const loadsBefore = requests.filter(
        (request) => request.method === "GET" && request.path.startsWith("/messages"),
      ).length;
      await page.evaluate(() => window.failureChat.releaseRerun());
      await page.waitForFunction(() => window.failureChat.snapshot().settledRerun);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const current = await snapshot();
      assert.equal(current.streaming, true, "old rerun settlement must not end the newer stream");
      assert.equal(current.loading, true, "old rerun finalizers must not clear newer loading");
      assert.equal(
        current.error,
        null,
        "old rerun errors must not replace the newer turn's status",
      );
      assert.equal(await newControl.inputValue(), "keep newer state");
      assert.equal(
        current.messages.length,
        4,
        "a stale snapshot must not replace optimistic messages",
      );
      assert.equal(
        requests.filter(
          (request) => request.method === "GET" && request.path.startsWith("/messages"),
        ).length,
        loadsBefore,
        "an old successful rerun must not reload over a new reply",
      );
      const saved = page.waitForResponse((response) =>
        response.url().endsWith("/messages/chat/complete"),
      );
      await page.evaluate(() => window.failureChat.done());
      await saved;
      await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
      console.log(
        `PASS old ${kind} ${rejected ? "failure" : "success"} after Stop/new send: newer stream/loading/error/optimistic controls retained`,
      );
    }
  }

  for (const kind of ["send", "retry", "edit"]) {
    await reset();
    if (kind !== "send") {
      rows.push(
        {
          id: "prepared-existing-user",
          conversationId: conversation.id,
          role: "user",
          content: "original Agent question",
          mode: "agent",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "prepared-existing-assistant",
          conversationId: conversation.id,
          role: "assistant",
          content: closed,
          mode: "agent",
          agentRun: {
            status: "completed",
            summary: "",
            steps: [{ type: "text", content: closed }],
          },
          createdAt: new Date(1).toISOString(),
        },
      );
      await page.evaluate(() => window.failureChat.reload());
    }
    let release;
    holdSettings = new Promise((resolve) => {
      release = resolve;
    });
    const settingRequest = page.waitForRequest((request) =>
      new URL(request.url()).searchParams.get("keys")?.includes("chat.systemPrompt"),
    );
    if (kind === "send") {
      await page.evaluate(() => window.failureChat.mode("agent"));
      await page.locator("textarea").fill("stopped prepared Agent question");
      await page.locator("textarea").press("Enter");
    } else if (kind === "retry") {
      await page.getByRole("button", { name: retryLabel, exact: true }).click();
    } else {
      await page.getByRole("button", { name: editLabel, exact: true }).click();
      await page.locator("textarea").first().fill("stopped prepared Agent edit");
      await page.locator("textarea").first().press("Enter");
    }
    await settingRequest;
    if (kind === "send") await page.evaluate(() => window.failureChat.remount());
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.waitForFunction(() => !window.failureChat.snapshot().loading);
    assert.equal(syncedPreparations, kind === "retry" ? 0 : 1);
    assert.equal(rows.length, 2, "Stop must retain exactly the original or prepared Agent round");
    assert.equal(
      rows.find((row) => row.role === "user").content,
      kind === "send"
        ? "stopped prepared Agent question"
        : kind === "edit"
          ? "stopped prepared Agent edit"
          : "original Agent question",
    );
    const stoppedReply = rows.find((row) => row.role === "assistant");
    assert.equal(stoppedReply.content, kind === "retry" ? closed : "");
    if (kind !== "retry") assert.equal(stoppedReply.finishReason, "stopped");
    await page.evaluate(() => window.failureChat.mode("chat"));
    await send();
    await emit('```openui-lang\nroot=Input($next,"Prepared next turn")\n$next="new"\n```');
    const settingsReturned = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.get("keys")?.includes("chat.systemPrompt"),
    );
    release();
    await settingsReturned;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const current = await snapshot();
    assert.equal(
      current.streaming,
      true,
      "old Agent preparation must not cancel a newer Chat turn",
    );
    assert.equal(current.loading, true);
    assert.equal(current.error, null);
    assert.equal(syncedPreparations, kind === "retry" ? 0 : 1, "Stop persists once");
    assert.equal(current.messages.length, 4);
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/messages/chat/complete"),
    );
    await page.evaluate(() => window.failureChat.done());
    await saved;
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    await page.evaluate(() => window.failureChat.reload());
    assert.equal(
      (await snapshot()).messages.length,
      4,
      "prepared stopped question survives reload",
    );
    console.log(
      `PASS Agent ${kind} stopped during preparation: question/prior reply persisted once, new turn survives late setup and reload`,
    );
  }

  for (const ending of ["failure", "stop"]) {
    for (const kind of ["openui-lang", "html-ui"]) {
      await reset();
      await send();
      const code =
        kind === "html-ui"
          ? '<input aria-label="Unclosed HTML"><script>window.marker=1</script>'
          : 'root=Input($value,"Unclosed UI")\n$value="draft"';
      const content = `${closed}\n\n\`\`\`${kind}\n${code}`;
      await emit(content);
      await amount.waitFor();
      if (ending === "failure") await fail();
      else {
        const saved = page.waitForResponse((response) =>
          response.url().endsWith("/messages/chat/complete"),
        );
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
        // Stop resolves generation immediately; persistence is a separate request.
        await saved;
      }
      assert.equal(
        await amount.isDisabled(),
        false,
        "the preceding closed block remains interactive",
      );
      if (kind === "html-ui") {
        assert.equal(
          await page.locator("iframe").getAttribute("sandbox"),
          "",
          "unclosed HTML must keep the script-free preview sandbox",
        );
        assert.doesNotMatch(await page.locator("iframe").getAttribute("srcdoc"), /<script/i);
      } else
        assert.equal(
          await page.getByRole("textbox", { name: "Unclosed UI", exact: true }).isDisabled(),
          true,
        );
      assert.equal(rows.find((row) => row.role === "assistant").content, content);
      await page.evaluate(async () => {
        await window.failureChat.reload();
        window.failureChat.remount();
      });
      if (kind === "html-ui")
        assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
      else
        assert.equal(
          await page.getByRole("textbox", { name: "Unclosed UI", exact: true }).isDisabled(),
          true,
        );
      console.log(
        `PASS ${ending} unclosed ${kind}: preceding block interactive, unfinished block inert after reload/remount`,
      );
    }
  }
  await reset();
  await send();
  await emit(closed);
  await fail();
  await page.evaluate(() => window.failureChat.protocol("acp"));
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  assert.equal(retries, 0);
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").content,
    closed,
  );
  await page.getByRole("button", { name: editLabel, exact: true }).click();
  await page.locator("textarea").first().fill("keep edited draft");
  const editsBefore = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/edit"),
  ).length;
  await page.locator("textarea").first().press("Enter");
  assert.equal(await page.locator("textarea").first().inputValue(), "keep edited draft");
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.path.endsWith("/edit"))
      .length,
    editsBefore,
  );
  console.log(
    "PASS historical Chat reruns under ACP are blocked before changing the previous answer or sending a request",
  );

  for (const welcome of [false, true]) {
    await reset();
    protocol = "acp";
    await page.evaluate((welcome) => window.failureChat.start("acp", welcome), welcome);
    await page.locator("textarea").fill("ACP draft must be kept");
    await page
      .getByText("此渠道仅支持 Agent 模式，请切换到 Agent 后发送。", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    await page.locator("textarea").press("Enter");
    assert.equal(prepares, 0);
    assert.equal(rows.length, 0);
    assert.equal(await page.locator("textarea").inputValue(), "ACP draft must be kept");
    await page.getByRole("button", { name: "Mode", exact: true }).click();
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), false);
    assert.equal(await page.locator("textarea").inputValue(), "ACP draft must be kept");
    assert.equal(
      requests.filter((request) => request.method === "POST" && request.path === "/conversations")
        .length,
      0,
    );
    console.log(
      `PASS ACP ${welcome ? "welcome" : "current"} composer: Chat blocked before writes, notice/draft retained, Agent remains available`,
    );
  }
  for (const kind of ["send", "retry", "edit"]) {
    await reset();
    if (kind !== "send") {
      rows.push(
        {
          id: "disconnected-user",
          conversationId: conversation.id,
          role: "user",
          content: "original disconnected question",
          mode: "agent",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "disconnected-assistant",
          conversationId: conversation.id,
          role: "assistant",
          content: closed,
          mode: "agent",
          agentRun: {
            status: "completed",
            summary: "Done",
            steps: [{ type: "text", content: closed, timestamp: 0 }],
          },
          createdAt: new Date(0).toISOString(),
        },
      );
      await page.evaluate(() => window.failureChat.reload());
    }
    let releaseSettings;
    holdSettings = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    const preparing = page.waitForRequest((request) =>
      new URL(request.url()).searchParams.get("keys")?.includes("chat.systemPrompt"),
    );
    if (kind === "send") {
      await page.evaluate(() => window.failureChat.mode("agent"));
      await page.locator("textarea").fill("disconnected fresh question");
      await page.locator("textarea").press("Enter");
    } else if (kind === "retry") {
      await page.getByRole("textbox", { name: "Persist amount", exact: true }).fill("27");
      await page.getByRole("button", { name: retryLabel, exact: true }).click();
    } else {
      await page.getByRole("button", { name: editLabel, exact: true }).click();
      await page.locator("textarea").first().fill("disconnected edited question");
      await page.locator("textarea").first().press("Enter");
    }
    await preparing;
    await page.evaluate(
      (keepClient) => window.failureChat.disconnectSidecar(keepClient),
      kind === "retry",
    );
    releaseSettings();
    const unavailable = await page.evaluate(() => window.failureChat.labels.sidecarNotReady);
    await page.getByRole("alert").filter({ hasText: unavailable }).waitFor();
    await page.waitForFunction(
      () => !window.failureChat.snapshot().streaming && !window.failureChat.snapshot().loading,
    );
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.title === label && !button.disabled,
        ),
      retryLabel,
    );
    assert.equal((await snapshot()).agentRuns, 0);
    assert.equal(rows.length, 2);
    assert.equal(syncedPreparations, kind === "retry" ? 0 : 1);
    assert.equal(
      rows.find((row) => row.role === "user").content,
      kind === "send"
        ? "disconnected fresh question"
        : kind === "edit"
          ? "disconnected edited question"
          : "original disconnected question",
    );
    if (kind === "retry") {
      assert.equal(rows.find((row) => row.role === "assistant").content, closed);
      assert.equal(
        await page.getByRole("textbox", { name: "Persist amount", exact: true }).inputValue(),
        "27",
      );
    } else assert.equal(rows.find((row) => row.role === "assistant").agentRun.status, "failed");
    await page.evaluate(() => {
      window.failureChat.reconnectSidecar();
      window.failureChat.mode("chat");
    });
    await page.locator("textarea").fill("new Chat after startup failure");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.failureChat.ready());
    await page.evaluate(() => window.failureChat.done());
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    console.log(
      `PASS Agent ${kind} disconnects during preparation: failure releases owner, preserves the round and allows recovery`,
    );
  }

  await reset();
  await page.evaluate(() => {
    window.failureChat.workspaceUnavailable();
    window.failureChat.mode("agent");
  });
  await page.locator("textarea").fill("refuse a run without its workspace");
  const workspaceRequestStart = requests.length;
  const workspaceSave = page.waitForResponse((response) =>
    response.url().endsWith("/messages/sync-sidecar"),
  );
  await page.locator("textarea").press("Enter");
  const workspaceError = await page.evaluate(() => window.failureChat.labels.workspaceUnavailable);
  await page.getByRole("alert").filter({ hasText: workspaceError }).waitFor();
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  await workspaceSave;
  const failedWorkspaceSave = requests
    .slice(workspaceRequestStart)
    .find((request) => request.path === "/messages/sync-sidecar").data;
  assert.match(failedWorkspaceSave.assistantMessageId, /^[a-f0-9-]{36}$/);
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").id,
    failedWorkspaceSave.assistantMessageId,
  );
  assert.equal((await snapshot()).agentRuns, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.role === "assistant").agentRun.status, "failed");
  console.log(
    "PASS unavailable default workspace: stale project root is refused, no Agent starts and the failed question persists",
  );

  for (const mode of ["chat", "agent"]) {
    await reset();
    await page.evaluate((mode) => window.failureChat.mode(mode), mode);
    await page.locator("textarea").fill(`Stop ${mode} after remount`);
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(
      (mode) => (mode === "agent" ? window.failureChat.agentReady() : window.failureChat.ready()),
      mode,
    );
    if (mode === "agent")
      assert.deepEqual((await snapshot()).agentWorkspaceRoots, ["/fixture/workspace"]);
    if (mode === "agent")
      await page.evaluate(() => window.failureChat.agentEmit("kept Agent partial"));
    else await emit("kept Chat partial");
    if (mode === "agent") await page.evaluate(() => window.failureChat.agentApproval());
    await page.evaluate(() => window.failureChat.remount());
    if (mode === "agent") {
      await page.getByTestId("sidecar-approval-deny").click();
      assert.deepEqual((await snapshot()).approvals, [
        { toolUseId: "fixture-approval", allow: false },
      ]);
      await page.evaluate(() => window.failureChat.agentApproval());
      await page.getByTestId("sidecar-approval-allow").waitFor();
    }
    const stoppedSave =
      mode === "agent"
        ? once(server, "fixture-agent-save-observed", { signal: AbortSignal.timeout(10_000) })
        : null;
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    const stopped = await snapshot();
    assert.equal(stopped.cancelled.length, 1, "remounted Stop must cancel the real owned run");
    await page.waitForFunction(() =>
      window.failureChat.snapshot().messages.some((message) => message.finishReason === "stopped"),
    );
    const contents = (await snapshot()).messages.map((message) => message.content);
    if (mode === "agent")
      await page.evaluate(() => {
        window.failureChat.agentEmit("ignored after remounted Stop");
        window.failureChat.agentApproval();
      });
    else await emit("ignored after remounted Stop");
    assert.deepEqual(
      (await snapshot()).messages.map((message) => message.content),
      contents,
    );
    assert.equal(await page.getByTestId("sidecar-approval-allow").count(), 0);
    if (stoppedSave) await stoppedSave;
    assert.equal(mode === "agent" ? syncedPreparations : completes, 1);
    await page.evaluate(() => window.failureChat.mode("chat"));
    await page.locator("textarea").fill("usable after remounted Stop");
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(
      (mode) => window.failureChat.snapshot().runs === (mode === "chat" ? 2 : 1),
      mode,
    );
    assert.equal((await snapshot()).streaming, true);
    await page.evaluate(() => window.failureChat.done());
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    console.log(
      `PASS ${mode} remount: real Stop cancels once, persists partial, ignores late text and allows the next turn`,
    );
  }

  await reset();
  let releaseAgentSave;
  const barrierRequestStart = requests.length;
  const agentSaveStarted = once(server, "fixture-agent-save-started", {
    signal: AbortSignal.timeout(10000),
  });
  holdAgentSave = new Promise((resolve) => {
    releaseAgentSave = resolve;
  });
  await page.evaluate(() => window.failureChat.mode("agent"));
  await page.locator("textarea").fill("Agent save barrier question");
  await page.locator("textarea").press("Enter");
  await page.waitForFunction(
    () => window.failureChat.agentReady() && !window.failureChat.snapshot().loading,
  );
  await page.evaluate(() => {
    window.failureChat.agentEmit("first saved Agent answer");
    window.failureChat.agentDone();
  });
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  // Execution finishes before asynchronous persistence necessarily reaches the
  // server. Observe the held request before asserting the one-save barrier.
  const [heldAgentSave] = await agentSaveStarted;
  assert.equal(heldAgentSave.userContent, "Agent save barrier question");
  assert.equal(syncedPreparations, 1);
  assert.equal(
    await page.getByRole("button", { name: retryLabel, exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.failureChat.remount());
  assert.equal(
    await page.getByRole("button", { name: retryLabel, exact: true }).isDisabled(),
    true,
  );
  const firstAgentSaved = page.waitForResponse((response) =>
    response.url().endsWith("/messages/sync-sidecar"),
  );
  releaseAgentSave();
  await firstAgentSaved;
  const stableAgentId = heldAgentSave.assistantMessageId;
  assert.match(stableAgentId, /^[a-f0-9-]{36}$/);
  await page.waitForFunction(
    (id) => window.failureChat.snapshot().messages.some((message) => message.id === id),
    stableAgentId,
  );
  await page.waitForFunction(() => window.failureChat.snapshot().activeMessages.length === 0);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.role === "assistant").id, stableAgentId);
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.waitForFunction(() => window.failureChat.snapshot().agentRuns === 2);
  await page.evaluate(() => {
    window.failureChat.agentEmit("second saved Agent answer");
    window.failureChat.agentDone(true);
  });
  await page.waitForFunction(
    (id) =>
      window.failureChat
        .snapshot()
        .messages.some(
          (message) =>
            message.id === id &&
            message.content === "second saved Agent answer" &&
            message.agentRun?.status === "completed",
        ),
    stableAgentId,
  );
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.role === "assistant").content, "second saved Agent answer");
  const agentSaves = requests
    .slice(barrierRequestStart)
    .filter((request) => request.path === "/messages/sync-sidecar");
  assert.equal(agentSaves.length, 2);
  assert.equal(agentSaves[1].data.assistantMessageId, stableAgentId);
  assert.equal(agentSaves[1].data.userMessageId, heldAgentSave.userMessageId);
  await page.waitForFunction(() => window.failureChat.snapshot().activeMessages.length === 0);
  console.log(
    "PASS Agent terminal save barrier: both callback orders persist once, remount cannot retry before ID reconciliation, subsequent same-ID retry finishes",
  );

  await reset();
  failAgentSaveOnce = true;
  const recoveryRequestStart = requests.length;
  await page.evaluate(() => window.failureChat.mode("agent"));
  await page.locator("textarea").fill("retain my generated result when saving fails");
  await page.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.failureChat.agentReady());
  await page.evaluate((content) => {
    window.failureChat.agentEmit(content);
    window.failureChat.agentDone();
  }, closed);
  const recoveryLabels = await page.evaluate(() => ({
    failed: window.failureChat.labels.saveFailed,
    retry: window.failureChat.labels.retrySave,
  }));
  const saveToast = page.locator("[data-sonner-toast]").filter({ hasText: recoveryLabels.failed });
  await saveToast.waitFor();
  await page.waitForFunction(() => window.failureChat.snapshot().activeMessages.length === 0);
  const unsavedReply = (await snapshot()).messages.find((message) => message.role === "assistant");
  assert.equal(unsavedReply.agentRun.status, "completed");
  assert.equal(unsavedReply.content, closed);
  assert.equal(rows.length, 0);
  const recoveryControl = page.getByRole("textbox", { name: "Persist amount", exact: true });
  await recoveryControl.fill("42");
  await page.evaluate(async () => {
    await window.failureChat.navigateConversation("other-conversation");
    await window.failureChat.navigateConversation("failure-conversation");
  });
  assert.equal(await recoveryControl.inputValue(), "42");
  assert.equal(
    (await snapshot()).messages.find((message) => message.role === "assistant").id,
    unsavedReply.id,
  );
  await saveToast.getByRole("button", { name: recoveryLabels.retry, exact: true }).click();
  await page.waitForFunction(() =>
    window.failureChat
      .snapshot()
      .messages.every(
        (message) => !window.failureChat.snapshot().activeMessages.includes(message.id),
      ),
  );
  await saveToast.waitFor({ state: "detached" });
  const recoverySaves = requests
    .slice(recoveryRequestStart)
    .filter((request) => request.path === "/messages/sync-sidecar");
  assert.equal(recoverySaves.length, 2);
  assert.deepEqual(recoverySaves[1].data, recoverySaves[0].data);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.role === "assistant").id, unsavedReply.id);
  assert.equal((await snapshot()).agentRuns, 1, "Retry save must never run the model again");
  assert.equal(await recoveryControl.inputValue(), "42");
  console.log(
    "PASS Agent save failure: persistent real toast, navigation retains reply/control state, Retry save reuses exact IDs/payload and never regenerates",
  );

  for (const { elsewhere, remount } of [
    { elsewhere: false, remount: false },
    { elsewhere: true, remount: false },
    { elsewhere: false, remount: true },
    { elsewhere: true, remount: true },
  ]) {
    await reset();
    const historical = [
      { id: "historical-user", role: "user", content: "historical question" },
      { id: "historical-reply", role: "assistant", content: "historical reply" },
    ].map((message) => ({
      ...message,
      conversationId: elsewhere ? "other-conversation" : conversation.id,
      mode: "chat",
      createdAt: new Date(0).toISOString(),
    }));
    rows.push(...historical);
    if (!elsewhere)
      await page.evaluate((messages) => window.failureChat.seedMessages(messages), historical);
    await page.evaluate(() => window.failureChat.mode("agent"));
    await page.locator("textarea").fill("keep this Agent running");
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(
      () => window.failureChat.agentReady() && !window.failureChat.snapshot().loading,
    );
    if (remount) await page.evaluate(() => window.failureChat.remount());
    if (elsewhere) {
      await page.evaluate(() => window.failureChat.showConversation("other-conversation"));
      await page.evaluate((messages) => window.failureChat.seedMessages(messages), historical);
    }
    assert.equal((await snapshot()).streaming, true);
    for (const retry of await page.getByRole("button", { name: retryLabel, exact: true }).all()) {
      assert.equal(
        await retry.isDisabled(),
        true,
        "historical retry must not start while an accepted Agent owns the composer",
      );
    }
    await page.getByRole("button", { name: editLabel, exact: true }).first().click();
    const edit = page.locator("textarea").first();
    await edit.fill("blocked edit during Agent");
    await edit.press("Enter");
    assert.equal(retries, 0);
    assert.equal(
      requests.some((request) => request.path === "/messages/historical-user/edit"),
      false,
      "editor Enter must obey the same running-turn admission as its disabled button",
    );
    assert.equal(
      (await snapshot()).messages.find((message) => message.id === "historical-user").content,
      "historical question",
    );
    assert.equal((await snapshot()).agentRuns, 1);
    assert.equal((await snapshot()).streaming, true);
    await edit.press("Escape");
    if (elsewhere) await page.evaluate(() => window.failureChat.agentFail());
    else await page.evaluate(() => window.failureChat.agentDone());
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    if (elsewhere) assert.equal((await snapshot()).error, "fixture Agent failed");
    await page.evaluate(() => window.failureChat.mode("chat"));
    await page.locator("textarea").fill("new Chat after Agent terminal");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.failureChat.ready());
    await page.evaluate(() => {
      window.failureChat.agentEmit("late finished Agent text");
      window.failureChat.agentDone();
      window.failureChat.agentFail();
    });
    assert.equal(
      (await snapshot()).streaming,
      true,
      "an ended Agent cannot release the newer Chat owner",
    );
    assert.equal((await snapshot()).error, null);
    assert.equal(
      (await snapshot()).messages.some((message) =>
        message.content.includes("late finished Agent"),
      ),
      false,
    );
    await page.evaluate(() => window.failureChat.done());
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    console.log(
      `PASS accepted Agent ${elsewhere ? "elsewhere" : "here"}${remount ? " after remount" : ""}: historical Retry and edit Enter cannot overlap or replace its turn`,
    );
  }
  const assertPolicy = (section, automatic) => {
    assert.equal(typeof section, "string", "every path must carry an explicit response policy");
    if (automatic) {
      assert.match(section, /## Interactive answers/);
      assert.match(section, /Slider\(/);
      assert.match(section, /## html-ui blocks/);
      assert.match(section, /Honor explicit requests for plain text/);
      assert.match(section, /never substitute an inline widget for execution/);
    } else {
      assert.match(section, /^## Response format: text only/);
      assert.ok(section.length < 1000, "Text only sends a short policy rather than the UI schema");
      assert.doesNotMatch(section, /## Interactive answers|Slider\(|## html-ui blocks/);
    }
  };
  const seedPolicyRound = async (mode, id, content = closed) => {
    rows.push(
      ...[
        { id: `${id}-user`, role: "user", content: "original policy question" },
        {
          id: `${id}-assistant`,
          role: "assistant",
          content,
          ...(mode === "agent"
            ? {
                agentRun: {
                  status: "completed",
                  summary: "Done",
                  steps: [{ type: "text", content, timestamp: 0 }],
                },
              }
            : {}),
        },
      ].map((message) => ({
        ...message,
        conversationId: conversation.id,
        mode,
        createdAt: new Date(0).toISOString(),
      })),
    );
    await page.evaluate(() => window.failureChat.reload());
    await page.getByRole("button", { name: retryLabel, exact: true }).waitFor();
  };
  for (const mode of ["chat", "agent"]) {
    for (const kind of ["send", "retry", "edit"]) {
      for (const automatic of [true, false]) {
        await reset();
        // Mount the old bubble under the opposite preference, then change the
        // live store without remounting. Its memoized callbacks must use now.
        await page.evaluate((value) => window.failureChat.policy(!value), automatic);
        const id = `policy-${mode}-${kind}-${automatic}`;
        if (kind !== "send") {
          await seedPolicyRound(mode, id);
          await page.getByRole("button", { name: retryLabel, exact: true }).evaluate((control) => {
            window.policyRetryControl = control;
          });
        }
        await page.evaluate((value) => window.failureChat.policy(value), automatic);
        if (kind !== "send") {
          assert.equal(
            await page
              .getByRole("button", { name: retryLabel, exact: true })
              .evaluate((control) => control === window.policyRetryControl),
            true,
            "a preference change keeps the existing reply action mounted",
          );
        }
        const requestIndex = requests.length;
        const path = `/messages/${id}-${kind === "edit" ? "user/edit" : "assistant/regenerate"}`;
        const rerunRequest =
          mode === "chat" && kind !== "send"
            ? page.waitForRequest(
                (request) =>
                  request.method() === "POST" && new URL(request.url()).pathname === path,
              )
            : null;
        if (kind === "send") {
          await page.evaluate((value) => window.failureChat.mode(value), mode);
          await page.locator("textarea").fill("policy request: make a real file and run its tests");
          await page.locator("textarea").press("Enter");
        } else if (kind === "retry") {
          await page.getByRole("button", { name: retryLabel, exact: true }).click();
        } else {
          await page.getByRole("button", { name: editLabel, exact: true }).click();
          await page
            .locator("textarea")
            .first()
            .fill("edited policy request: return readable source");
          await page.locator("textarea").first().press("Enter");
        }
        if (rerunRequest) await rerunRequest;
        else {
          await page.waitForFunction(
            (value) =>
              value === "agent" ? window.failureChat.agentReady() : window.failureChat.ready(),
            mode,
          );
        }
        const captured = await snapshot();
        if (mode === "agent") {
          assertPolicy(captured.agentRequest.systemPrompt, automatic);
          assert.equal(captured.agentRequest.permissionMode, "default");
          assert.equal(captured.agentRuns, 1, "selection adds no classifier or extra Agent run");
          assert.equal(captured.runs, 0);
          assert.equal(
            captured.agentRequest.prompt,
            kind === "send"
              ? "policy request: make a real file and run its tests"
              : kind === "edit"
                ? "edited policy request: return readable source"
                : "original policy question",
          );
          await page.evaluate(() => {
            window.failureChat.agentEmit("Policy fixture complete.");
            window.failureChat.agentDone();
          });
        } else if (kind === "send") {
          const messages = captured.chatMessages;
          assertPolicy(
            messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n\n"),
            automatic,
          );
          assert.deepEqual(
            messages.filter((message) => message.role === "user"),
            [{ role: "user", content: "policy request: make a real file and run its tests" }],
          );
          assert.equal(captured.runs, 1, "selection adds no classifier or extra Chat run");
          assert.equal(captured.agentRuns, 0);
          await emit("Policy fixture complete.");
          await page.evaluate(() => window.failureChat.done());
        } else {
          const request = requests
            .slice(requestIndex)
            .find((request) => request.method === "POST" && request.path === path);
          assert.ok(request);
          assertPolicy(request.data.appendSystemPrompt, automatic);
          assert.equal(captured.runs, 0);
          assert.equal(captured.agentRuns, 0);
        }
        await page.waitForFunction(
          () => !window.failureChat.snapshot().streaming && !window.failureChat.snapshot().loading,
        );
        console.log(
          `PASS current response policy ${mode}/${kind}/${automatic ? "Auto" : "Text only"}: real transport carries selected contract after a live preference change`,
        );
      }
    }
  }
  for (const mode of ["chat", "agent"]) {
    await reset();
    const history =
      '```openui-lang\nroot=Col([Input($balance,"History value","number"),Text($balance),Button("Explain history",@ToAssistant("Explain the current historical value",{amount:$balance}))])\n$balance=5\n```';
    await seedPolicyRound(mode, `policy-history-${mode}`, history);
    const historicalInput = page.getByRole("textbox", { name: "History value", exact: true });
    await historicalInput.fill("19");
    await historicalInput.evaluate((control) => {
      window.policyHistoricalControl = control;
    });
    await page.locator("textarea").fill("Keep my unsent draft");
    await page.evaluate(() => window.failureChat.policy(false));
    assert.equal(
      await historicalInput.evaluate((control) => control === window.policyHistoricalControl),
      true,
    );
    assert.equal(await historicalInput.inputValue(), "19");
    assert.equal(await page.locator("textarea").inputValue(), "Keep my unsent draft");
    const before = await snapshot();
    await page.getByRole("button", { name: "Explain history", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("textarea")?.value.includes("Explain the current historical value"),
    );
    const draft = await page.locator("textarea").inputValue();
    assert.match(draft, /^Keep my unsent draft\n\nExplain the current historical value/);
    assert.match(draft, /19/);
    assert.equal(await historicalInput.inputValue(), "19");
    const after = await snapshot();
    assert.equal(after.policy, false);
    assert.equal(after.runs, before.runs);
    assert.equal(after.agentRuns, before.agentRuns);
    assert.equal(prepares, 0);
    assert.equal(syncedPreparations, 0);
    await page.evaluate(() => window.failureChat.remount());
    assert.equal(await historicalInput.inputValue(), "19");
    console.log(
      `PASS Text only historical ${mode} widget: live local state survives policy change/remount; follow-up appends to the draft without a model call`,
    );
  }
  // Output-limit scenarios use the real ChatArea and persisted Bubble mapping.
  const truncationLabels = await page.evaluate(() => ({
    label: window.failureChat.labels.truncation,
    error: window.failureChat.labels.truncationError,
  }));
  const truncationLabel = () =>
    page.getByText(truncationLabels.label, { exact: true }).and(page.locator("span"));
  const waitForTruncation = () =>
    page.waitForFunction(
      () =>
        !window.failureChat.snapshot().streaming &&
        window.failureChat.snapshot().error === window.failureChat.labels.truncationError,
    );
  for (const empty of [false, true]) {
    await reset();
    await send();
    await page.evaluate(() => window.failureChat.truncationCapture());
    if (!empty) await emit(truncationPartial);
    await page.evaluate(() => {
      window.failureChat.truncationUsage();
      window.failureChat.truncationFail();
    });
    await waitForTruncation();
    const current = (await snapshot()).messages.find((message) => message.role === "assistant");
    assert.equal(current.content, empty ? "" : truncationPartial);
    assert.equal(current.finishReason, "length");
    assert.deepEqual(current.usage, truncationUsage);
    const persisted = rows.find((row) => row.id === current.id);
    assert.equal(persisted.content, current.content);
    assert.equal(persisted.finishReason, "length");
    assert.deepEqual(JSON.parse(persisted.usage), truncationUsage);
    assert.equal(completes, 1, "an explicit output limit persists the Chat result once");
    await truncationLabel().waitFor();
    await page.getByRole("alert").filter({ hasText: truncationLabels.error }).waitFor();
    assert.equal(
      (await page.locator("body").innerText()).includes("fixture raw output limit"),
      false,
    );
    if (!empty) {
      assert.equal(
        await page.getByRole("textbox", { name: "Truncated UI", exact: true }).isDisabled(),
        true,
        "an unfinished output-limit program remains inert",
      );
    }
    await page.evaluate(async () => {
      await window.failureChat.reload();
      window.failureChat.remount();
    });
    await truncationLabel().waitFor();
    const reloaded = (await snapshot()).messages.find((message) => message.id === current.id);
    assert.equal(reloaded.content, current.content);
    assert.equal(reloaded.finishReason, "length");
    assert.deepEqual(reloaded.usage, truncationUsage);
    if (!empty) {
      assert.equal(
        await page.getByRole("textbox", { name: "Truncated UI", exact: true }).isDisabled(),
        true,
      );
      await page.locator("textarea").fill("new question after output limit");
      await page.locator("textarea").press("Enter");
      await page.waitForFunction(() => window.failureChat.snapshot().runs === 2);
      await emit("new answer remains owned by its own turn");
      await page.evaluate(() => window.failureChat.truncationLate());
      const afterLate = await snapshot();
      assert.equal(afterLate.streaming, true, "a late old error cannot finish a newer request");
      assert.equal(afterLate.error, null);
      assert.equal(afterLate.messages.at(-1).content, "new answer remains owned by its own turn");
      assert.equal(afterLate.messages.at(-1).finishReason, undefined);
      await page.evaluate(() => window.failureChat.done());
      await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
      assert.equal(rows.at(-1).finishReason, null);
    }
    console.log(
      `PASS sidecar ${empty ? "empty" : "partial"} output limit: exact content/usage, structured notice, reload label${empty ? "" : ", inert program and ignored late error"}`,
    );
  }

  for (const kind of ["retry", "edit"]) {
    await reset();
    await send();
    await emit(closed);
    await fail();
    retryMode = "truncated-partial";
    truncationEdit = true;
    await page.evaluate((kind) => {
      window.failureChat.deferRerun(kind, false);
      window.failureChat.remount();
    }, kind);
    if (kind === "retry") {
      await page.getByRole("button", { name: retryLabel, exact: true }).click();
    } else {
      await page.getByRole("button", { name: editLabel, exact: true }).click();
      await page.locator("textarea").first().fill("deferred output-limit edit");
      await page.locator("textarea").first().press("Enter");
    }
    await page.waitForFunction(() => window.failureChat.snapshot().heldRerun);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.locator("textarea").fill("new turn before old output-limit response");
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(() => window.failureChat.snapshot().runs === 2);
    await emit('```openui-lang\nroot=Input($next,"New turn")\n$next="active"\n```\nNew partial');
    const newControl = page.getByRole("textbox", { name: "New turn", exact: true });
    await newControl.fill("keep newer truncation state");
    const loadsBefore = requests.filter(
      (request) => request.method === "GET" && request.path.startsWith("/messages"),
    ).length;
    await page.evaluate(() => window.failureChat.releaseRerun());
    await page.waitForFunction(() => window.failureChat.snapshot().settledRerun);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const current = await snapshot();
    assert.equal(current.streaming, true, "old SSE output limits cannot finish newer streams");
    assert.equal(current.loading, true, "old SSE output limits cannot clear newer loading");
    assert.equal(current.error, null, "old structured errors cannot replace the newer status");
    assert.equal(current.messages.length, 4);
    assert.equal(current.messages.at(-1).finishReason, undefined);
    assert.equal(current.messages.at(-1).usage, undefined);
    assert.equal(await newControl.inputValue(), "keep newer truncation state");
    assert.equal(
      requests.filter((request) => request.method === "GET" && request.path.startsWith("/messages"))
        .length,
      loadsBefore,
      "an old truncated response must not reload over the newer answer",
    );
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/messages/chat/complete"),
    );
    await page.evaluate(() => window.failureChat.done());
    await saved;
    await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
    console.log(
      `PASS delayed truncated SSE ${kind}: old error/usage/content do not mutate the newer turn`,
    );
  }

  await reset();
  await seedPolicyRound("chat", "limit-retry");
  retryMode = "truncated-partial";
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await waitForTruncation();
  let truncatedReply = (await snapshot()).messages.find((message) => message.role === "assistant");
  assert.equal(truncatedReply.id, "limit-retry-assistant");
  assert.equal(truncatedReply.content, truncationPartial);
  assert.equal(truncatedReply.finishReason, "length");
  assert.deepEqual(truncatedReply.usage, truncationUsage);
  await truncationLabel().waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Truncated UI", exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.failureChat.reload());
  await truncationLabel().waitFor();
  assert.equal((await snapshot()).messages.at(-1).finishReason, "length");
  assert.deepEqual((await snapshot()).messages.at(-1).usage, truncationUsage);
  console.log(
    "PASS SSE truncated retry: structured error/usage reach the actual bubble and survive reload",
  );

  await reset();
  await seedPolicyRound("chat", "limit-empty-retry");
  const previousUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
  Object.assign(
    rows.find((row) => row.id === "limit-empty-retry-assistant"),
    {
      finishReason: "stopped",
      usage: JSON.stringify(previousUsage),
    },
  );
  await page.evaluate(() => window.failureChat.reload());
  retryMode = "truncated-empty";
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await waitForTruncation();
  const restored = (await snapshot()).messages.find((message) => message.role === "assistant");
  assert.equal(restored.content, closed);
  assert.equal(
    restored.finishReason,
    "stopped",
    "a zero-output retry keeps the old reply's status",
  );
  assert.deepEqual(
    restored.usage,
    previousUsage,
    "a zero-output retry keeps the old reply's usage",
  );
  assert.equal(await truncationLabel().count(), 0);
  assert.equal(rows.find((row) => row.id === restored.id).finishReason, "stopped");
  console.log(
    "PASS zero-output truncated SSE retry: prior reply/content/usage/end state remain intact",
  );

  await reset();
  rows.push({
    id: "limit-edit-user",
    conversationId: conversation.id,
    role: "user",
    content: "original question before edit limit",
    mode: "chat",
    createdAt: new Date(0).toISOString(),
  });
  await page.evaluate(() => window.failureChat.reload());
  truncationEdit = true;
  await page.getByRole("button", { name: editLabel, exact: true }).click();
  await page.locator("textarea").first().fill("edited question reaching output limit");
  await page.locator("textarea").first().press("Enter");
  await waitForTruncation();
  truncatedReply = (await snapshot()).messages.find((message) => message.role === "assistant");
  assert.equal(truncatedReply.id, "saved-edited-tail");
  assert.equal(truncatedReply.content, truncationPartial);
  assert.equal(truncatedReply.finishReason, "length");
  assert.deepEqual(truncatedReply.usage, truncationUsage);
  assert.equal(
    rows.find((row) => row.role === "user").content,
    "edited question reaching output limit",
  );
  await page.evaluate(async () => {
    await window.failureChat.reload();
    window.failureChat.remount();
  });
  await truncationLabel().waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Truncated UI", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual((await snapshot()).messages.at(-1).usage, truncationUsage);
  console.log(
    "PASS truncated SSE tail edit: persisted reply identity/usage/label and edited question survive reload",
  );

  await reset();
  budgetPrepare = true;
  await page.locator("textarea").fill("over-budget fixture request");
  await page.locator("textarea").press("Enter");
  const budgetLabel = await page.evaluate(() => window.failureChat.labels.budget);
  const failedLabel = await page.evaluate(() => window.failureChat.labels.failed);
  const emptyLabel = await page.evaluate(() => window.failureChat.labels.empty);
  await page.waitForFunction(
    () =>
      !window.failureChat.snapshot().streaming &&
      window.failureChat.snapshot().messages.length === 2,
  );
  assert.equal((await snapshot()).messages.at(-1).id, "saved-assistant-1");
  assert.equal((await snapshot()).messages.at(-1).content, "");
  assert.equal((await snapshot()).messages.at(-1).finishReason, "context_budget_exceeded");
  assert.equal((await snapshot()).runs, 0, "budget rejection never starts a sidecar completion");
  await page.getByText(budgetLabel, { exact: true }).first().waitFor();
  budgetPrepare = false;
  await send();
  await emit("short follow-up succeeded");
  await page.evaluate(() => window.failureChat.done());
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  await page.evaluate(() => window.failureChat.reload());
  await page.getByText(budgetLabel, { exact: true }).waitFor();
  assert.equal(await page.getByText(emptyLabel, { exact: true }).count(), 0);
  assert.equal((await snapshot()).messages[1].finishReason, "context_budget_exceeded");
  console.log(
    "PASS prepare budget rejection: saved identity, no model run, localized reason survives next send and reload",
  );

  for (const partial of ["", "```openui-lang\nroot = Card("]) {
    await reset();
    await send();
    if (partial) await emit(partial);
    await fail();
    assert.equal(rows.at(-1).content, partial);
    assert.equal(rows.at(-1).finishReason, "error");
    await page.evaluate(() => window.failureChat.reload());
    await page.getByText(failedLabel, { exact: true }).waitFor();
    assert.equal(await page.getByText(emptyLabel, { exact: true }).count(), 0);
    assert.equal((await snapshot()).messages.at(-1).content, partial);
    assert.equal((await snapshot()).messages.at(-1).finishReason, "error");
  }
  console.log(
    "PASS empty and partial provider failures: exact Markdown plus localized durable reason after reload",
  );

  await reset();
  await send();
  await emit("This streamed text must be withdrawn.");
  await page.evaluate(() => window.failureChat.refuse());
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  assert.equal(rows.at(-1).content, "");
  assert.equal(rows.at(-1).finishReason, "refused");
  const refusedLabel = await page.evaluate(() => window.failureChat.labels.refused);
  await page.getByText(refusedLabel, { exact: true }).first().waitFor();
  assert.equal((await snapshot()).messages.at(-1).content, "");
  console.log(
    "PASS ordinary OpenAI refusal withdraws streamed text and forwards prepared save token",
  );

  await reset();
  await send();
  await emit("Previous answer must not return after a refused retry.");
  await page.evaluate(() => window.failureChat.done());
  await page.waitForFunction(() => !window.failureChat.snapshot().streaming);
  retryMode = "refused";
  await page.getByRole("button", { name: retryLabel, exact: true }).click();
  await page.getByText(refusedLabel, { exact: true }).first().waitFor();
  assert.equal((await snapshot()).messages.at(-1).content, "");
  assert.equal((await snapshot()).messages.at(-1).finishReason, "refused");
  await page.evaluate(() => window.failureChat.reload());
  await page.getByText(refusedLabel, { exact: true }).first().waitFor();
  assert.equal((await snapshot()).messages.at(-1).content, "");
  console.log("PASS refused retry replaces old answer consistently before and after reload");

  assert.deepEqual(errors, []);
  console.log("GenUI actual Chat failure browser regressions passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
