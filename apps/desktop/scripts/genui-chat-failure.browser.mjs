/** Real composer/send/error/retry paths with a local DB API and fake sidecar. */
import assert from "node:assert/strict";
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
let prepares = 0;
let completes = 0;
let retries = 0;
let holdComplete = null;
let holdSettings = null;
let syncedPreparations = 0;
let retryMode = "success";
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
const json = (response, value, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
const server = http.createServer(async (request, response) => {
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
  if (path === "/conversations") return json(response, { conversations: [conversation] });
  if (path === "/messages" || path === "/messages/failure-conversation")
    return json(response, { messages: rows });
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
        conversationId: conversation.id,
        role,
        content,
        mode: "chat",
        createdAt: new Date().toISOString(),
      })),
    );
    return json(response, {
      userMessageId,
      assistantMessageId,
      apiKey: "fixture-only",
      baseUrl: "http://fixture.invalid",
      protocol,
      model: "fixture-model",
      messages: [{ role: "user", content: data.content }],
    });
  }
  if (path === "/messages/chat/complete") {
    completes++;
    const held = holdComplete;
    holdComplete = null;
    if (held) {
      await held.promise;
      if (held.reject) return json(response, { error: "fixture old save failed" }, 500);
    }
    const row = rows.find((row) => row.id === data.assistantMessageId);
    assert.ok(row, "completion must use the persisted assistant ID");
    Object.assign(row, { content: data.content, updatedAt: new Date().toISOString() });
    return json(response, { success: true });
  }
  if (path === "/messages/sync-sidecar") {
    syncedPreparations++;
    const userMessageId = data.userMessageId ?? `prepared-user-${syncedPreparations}`;
    const assistantMessageId =
      data.assistantMessageId ?? `prepared-assistant-${syncedPreparations}`;
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
    const generated =
      retryMode === "success" ? retryText : retryMode === "partial-error" ? retryPartial : "";
    if (generated) row.content = generated;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const terminal =
      retryMode === "success"
        ? { type: "done", messageId: id, model: "fixture-model" }
        : {
            type: "error",
            message: "fixture retry interrupted",
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
    rows.push({
      id,
      conversationId: conversation.id,
      role: "assistant",
      content: retryPartial,
      mode: "chat",
      createdAt: new Date().toISOString(),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      [
        { type: "delta", content: retryPartial },
        {
          type: "error",
          message: "fixture edit interrupted",
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
    // Finishing a reply starts message/conversation reloads. Let those real
    // requests finish before replacing the root/store for the next scenario.
    await page.waitForLoadState("networkidle");
    rows.length = 0;
    prepares = 0;
    completes = 0;
    retries = 0;
    retryMode = "success";
    syncedPreparations = 0;
    protocol = "openai";
    await page.evaluate(() => window.failureChat.start());
  };
  const send = async () => {
    await page.locator("textarea").fill("test failure");
    await page.locator("textarea").press("Enter");
    await page.waitForFunction(() => window.failureChat.ready());
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
  assert.deepEqual(errors, []);
  console.log("GenUI actual Chat failure browser regressions passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
