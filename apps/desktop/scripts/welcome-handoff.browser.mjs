import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = process.env.OPENHORN_WELCOME_EVIDENCE || "/tmp/openhorn-welcome-handoff-evidence";
await mkdir(evidence, { recursive: true });
const child = spawn(
  "bun",
  [path.join(desktop, "../server/src/routes/reviewWorkspaces.browser-fixture.ts")],
  {
    cwd: path.join(desktop, "../server"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OPENHORN_SEARCH_VERSION_SYNTHETIC: "1",
      OPENHORN_TEST_DATABASE_URL: "file::memory:",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "",
  browser,
  server;
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const checks = [],
  errors = [],
  unexpected = [],
  requests = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  const api = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Fixture startup: ${stderr}`)), 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const data = JSON.parse(line);
          if (data.url) {
            clearTimeout(timer);
            resolve(data.url);
          }
        } catch {}
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exit ${code}: ${stderr}`));
    });
  });
  const json = async (endpoint, method = "GET", body) => {
    const response = await fetch(`${api}${endpoint}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.ok, true, JSON.stringify(value));
    return value;
  };
  const existing = (
    await json("/conversations", "POST", {
      title: "Existing safe conversation",
      defaultMode: "chat",
      forceNew: true,
    })
  ).conversation;
  process.env.VITE_API_BASE = api;
  process.chdir(desktop);
  server = await createServer({
    root: desktop,
    configFile: path.join(desktop, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: 24000 + Math.floor(Math.random() * 9000),
      strictPort: true,
      watch: null,
      hmr: false,
    },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let creationGate = null,
    creationEntered,
    creationReply = null;
  const messageRequests = [];
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) {
      unexpected.push(url.href);
      return route.abort();
    }
    requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/conversations" && request.method() === "POST" && creationGate) {
      const reply = creationReply;
      creationEntered?.();
      await creationGate;
      if (reply)
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ conversation: reply }),
        });
    }
    if (url.pathname.startsWith("/messages") && request.method() === "POST") {
      messageRequests.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic stop before model request" }),
      });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${origin}/tests/welcome-handoff.html`);
  await page.getByRole("button", { name: "Existing safe conversation", exact: true }).waitFor();
  let release;
  const started = new Promise((done) => {
    creationEntered = done;
  });
  creationGate = new Promise((done) => {
    release = done;
  });
  await page.locator("textarea").first().fill("Question meant for a new conversation");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await started;
  assert.equal(await page.evaluate(() => window.welcomeTest.pending()), null);
  await page.getByRole("button", { name: "Existing safe conversation", exact: true }).click();
  await page.waitForFunction((id) => window.welcomeTest.current() === id, existing.id);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/conversations" && r.request().method() === "POST",
  );
  release();
  creationGate = null;
  const created = (await (await response).json()).conversation;
  await page.waitForFunction((id) => !!window.welcomeTest.draft(id), created.id);
  assert.equal(await page.evaluate(() => window.welcomeTest.current()), existing.id);
  assert.equal(await page.locator("textarea").first().inputValue(), "");
  assert.equal(messageRequests.length, 0);
  assert.equal(
    await page.evaluate((id) => window.welcomeTest.draft(id)?.text, created.id),
    "Question meant for a new conversation",
  );
  pass(
    "leaving welcome while create is pending neither installs nor sends its input in another conversation",
  );
  await page.evaluate(() => window.welcomeTest.welcome());
  await page.locator("textarea").first().fill("Old pending welcome input");
  const aliasStarted = new Promise((done) => {
    creationEntered = done;
  });
  creationGate = new Promise((done) => {
    release = done;
  });
  creationReply = existing;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await aliasStarted;
  await page.getByRole("button", { name: "Existing safe conversation", exact: true }).click();
  await page.locator("textarea").first().fill("New draft typed while creation waits");
  const aliasResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/conversations" && r.request().method() === "POST",
  );
  release();
  creationGate = null;
  creationReply = null;
  await aliasResponse;
  await page.waitForFunction(() => {
    const value = document.querySelector("textarea")?.value ?? "";
    return (
      value.includes("New draft typed while creation waits") &&
      value.includes("Old pending welcome input")
    );
  });
  assert.equal(messageRequests.length, 0);
  pass(
    "a delayed response reusing a selected conversation preserves both the newer draft and old welcome input",
  );
  await page.evaluate(() => window.welcomeTest.welcome());
  await page.locator("textarea").first().fill("Normal bound welcome question");
  const nextResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/conversations" && r.request().method() === "POST",
  );
  const preparedRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname.startsWith("/messages") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).dblclick({ delay: 10 });
  const target = (await (await nextResponse).json()).conversation;
  try {
    await preparedRequest;
  } catch (error) {
    console.error(JSON.stringify(await page.evaluate(() => window.welcomeTest.diagnostics())));
    console.error(JSON.stringify({ messageRequests }));
    throw error;
  }
  assert.equal(messageRequests.length, 1);
  assert.equal(messageRequests[0].body.conversationId, target.id);
  assert.equal(messageRequests[0].body.content, "Normal bound welcome question");
  pass("normal welcome creation sends exactly one prompt bound to its actual target");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    `${JSON.stringify({ checks, errors, unexpected, messageRequests }, null, 2)}\n`,
  );
  console.log(`Evidence: ${evidence}`);
} finally {
  child.kill("SIGTERM");
  await browser?.close();
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
}
