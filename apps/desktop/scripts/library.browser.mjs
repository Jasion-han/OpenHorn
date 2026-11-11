import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = process.env.OPENHORN_LIBRARY_EVIDENCE || "/tmp/openhorn-library-evidence";
await mkdir(evidence, { recursive: true });
const child = spawn(
  "bun",
  [path.join(desktop, "../server/src/routes/reviewWorkspaces.browser-fixture.ts")],
  {
    cwd: path.join(desktop, "../server"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OPENHORN_REVIEW_LIVE_JEV: "0",
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
  const project = (
    await json("/projects", "POST", { name: "Synthetic project", rootPath: "/synthetic/library" })
  ).project;
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
  let hold = null,
    entered = null,
    matchHold = () => false;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) {
      unexpected.push(url.href);
      return route.abort();
    }
    requests.push({ method: request.method(), path: url.pathname });
    if (hold && matchHold(url, request)) {
      entered?.();
      await hold;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/library.html`);
  const view = page.getByTestId("library-view");
  const more = async (name) => {
    await view.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  const upload = async (name, content) => {
    await view.getByRole("button", { name: "导入资料", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("选择文件")
      .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
    await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await view.getByRole("heading", { name, exact: true }).waitFor();
  };
  await view.getByText("还没有资料", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重建索引", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "下载原件", exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidence, "library-empty.png") });
  pass("existing Library entry opens a quiet empty view with secondary actions hidden");
  await view.getByRole("button", { name: "导入资料", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("选择文件").setInputFiles({
    name: "draft.md",
    mimeType: "text/plain",
    buffer: Buffer.from("Unsent draft"),
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.getByRole("button", { name: "继续编辑", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await dialog.getByRole("button", { name: "放弃修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  pass("upload draft discard stays in one dialog and performs no upload");
  await upload(
    "shipping.md",
    "# Shipping\nShipping costs 12 coins. Returns take 7 days.\n<script>window.libraryUnsafe=true</script>",
  );
  const firstId = (await json("/library")).documents[0].id;
  assert.equal(await page.evaluate(() => window.libraryUnsafe), undefined);
  assert.ok((await view.textContent()).includes("Shipping costs 12 coins"));
  await view.getByRole("button", { name: /shipping.md/ }).click();
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  pass("text imports and same-document re-selection show escaped original text");
  await upload(
    "shipping.md",
    "# Shipping\nShipping costs 12 coins. Returns take 7 days.\n<script>window.libraryUnsafe=true</script>",
  );
  assert.equal((await json("/library")).documents.length, 1);
  pass("duplicate upload reuses one original document and closes the form");
  await view.getByLabel("资料范围").selectOption(`project:${project.id}`);
  await view.getByText("还没有资料", { exact: true }).waitFor();
  await upload("project.txt", "Shipping project only 55 coins.");
  await view.getByLabel("资料范围").selectOption("personal");
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  assert.equal(await view.getByRole("button", { name: /project.txt/ }).count(), 0);
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("shipping");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view.getByRole("complementary", { name: "匹配片段", exact: true }).waitFor();
  assert.ok((await view.textContent()).includes("片段 1"));
  assert.equal((await view.textContent()).includes("project only"), false);
  pass("project/personal scope and keyword fragments remain separate");
  await page.getByRole("button", { name: "统一搜索", exact: true }).click();
  await page.getByRole("textbox", { name: "统一搜索", exact: true }).fill("project only");
  await page.locator('[data-search-kind="library"]').filter({ hasText: "project.txt" }).click();
  await view.getByRole("heading", { name: "project.txt", exact: true }).waitFor();
  assert.equal(await view.getByLabel("资料范围").inputValue(), `project:${project.id}`);
  await view.getByLabel("资料范围").selectOption("personal");
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("shipping");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view.getByRole("complementary", { name: "匹配片段", exact: true }).waitFor();
  pass("unified search opens an owned Library result in its actual project scope");

  await page.screenshot({ path: path.join(evidence, "library-search.png") });
  await page.setViewportSize({ width: 780, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: path.join(evidence, "library-narrow.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  pass("Library retains scope/search/content without horizontal overflow at a narrow viewport");
  await upload("binary.txt", Buffer.from([0xff, 0xfe]));
  await view
    .getByText("文件不是有效的 UTF-8 文本，或包含二进制字符，请转换后重试。", { exact: true })
    .waitFor();
  const failedId = (await json("/library")).documents.find((d) => d.fileName === "binary.txt").id;
  assert.equal((await fetch(`${api}/library/${failedId}/original`)).status, 200);
  pass("invalid text retains a downloadable original and reports an indexing failure");
  await more("基于此范围提问");
  dialog = page.getByRole("dialog");
  const details = dialog.locator("details");
  assert.equal(await details.getAttribute("open"), null);
  await dialog.getByLabel("问题", { exact: true }).fill("no_matching_keywords");
  await dialog.getByRole("button", { name: "准备聊天草稿", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "没有找到可用的相关片段" }).waitFor();
  assert.equal((await json("/conversations")).conversations.length, 0);
  assert.equal(
    await dialog.getByLabel("问题", { exact: true }).inputValue(),
    "no_matching_keywords",
  );
  pass("no-source question shows an in-form error, preserves input and creates no chat");
  await dialog.getByLabel("问题", { exact: true }).fill("shipping");
  await page.evaluate(() => window.libraryTest.leave());
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await view.waitFor();
  await more("基于此范围提问");
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByLabel("问题", { exact: true }).inputValue(), "shipping");
  pass("question draft survives navigation without crossing the chosen scope");
  await dialog.getByRole("button", { name: "准备聊天草稿", exact: true }).dblclick({ delay: 10 });
  await page
    .getByTestId("handoff")
    .getByText(/Shipping costs 12 coins/)
    .waitFor();
  const pending = await page.evaluate(() => window.libraryTest.pending());
  assert.equal(pending.autoSend, false);
  assert.equal(
    pending.conversationId,
    (await json("/library/questions")).questions[0].conversationId,
  );
  assert.equal(
    requests.filter((r) => r.path === "/library/questions" && r.method === "POST").length,
    2,
  ); // failed + successful, not doubled
  assert.equal(
    requests.some((r) => r.path.includes("/messages") && r.method === "POST"),
    false,
  );
  assert.equal((await json("/__fixture/decision-stats")).calls, 0);
  pass("double-submit prepares one editable sourced Chat draft with no model request");
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await view.waitFor();
  await more("问答记录");
  dialog = page.getByRole("dialog");
  await dialog.getByText("shipping", { exact: true }).waitFor();
  await dialog.locator("summary").filter({ hasText: "来源快照" }).click();
  assert.ok((await dialog.textContent()).includes("Shipping costs 12 coins"));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  let releaseRefreshSearch;
  const refreshSearchStarted = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    releaseRefreshSearch = resolve;
  });
  matchHold = (url) => url.pathname === "/library/search";
  const librarySearchField = view.getByRole("textbox", { name: "检索资料", exact: true });
  const librarySearchButton = view.getByRole("button", { name: "检索资料", exact: true });
  await librarySearchField.fill("shipping");
  await librarySearchButton.click();
  await refreshSearchStarted;
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/library" && response.request().method() === "GET",
  );
  await more("刷新");
  await refreshed;
  const delayedSearch = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/library/search",
  );
  releaseRefreshSearch();
  hold = null;
  await (await delayedSearch).finished();
  await librarySearchButton.click();
  await view.getByRole("complementary", { name: "匹配片段", exact: true }).waitFor();
  pass("refresh cancels stale search without disabling another search of the same term");
  // A delayed search must not repopulate a new scope.
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    release = resolve;
  });
  matchHold = (url) => url.pathname === "/library/search";
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("shipping");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await started;
  await view.getByLabel("资料范围").selectOption(`project:${project.id}`);
  release();
  hold = null;
  await view.getByRole("heading", { name: "project.txt", exact: true }).waitFor();
  assert.equal(await view.getByRole("complementary", { name: "匹配片段", exact: true }).count(), 0);
  pass("late keyword results cannot overwrite a newly selected project scope");
  // A delayed unified-search handoff must not undo an explicit scope choice.
  const targetStarted = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    release = resolve;
  });
  matchHold = (url) => url.pathname === `/library/${firstId}`;
  await page.evaluate((id) => window.libraryTest.target(id), firstId);
  await targetStarted;
  await view.getByLabel("资料范围").selectOption("all");
  release();
  hold = null;
  await page.waitForTimeout(150);
  assert.equal(await view.getByLabel("资料范围").inputValue(), "all");
  pass("late unified-search navigation cannot override an explicit Library choice");
  await view.getByLabel("资料范围").selectOption("personal");
  await view.getByRole("button", { name: /shipping.md/ }).click();
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  await more("重建索引");
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  await more("删除资料");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await view.getByRole("button", { name: "删除资料", exact: true }).click();
  await view.getByRole("button", { name: /shipping.md/ }).waitFor({ state: "hidden" });
  assert.equal((await json("/library/search?q=shipping")).results.length, 0);
  await more("问答记录");
  dialog = page.getByRole("dialog");
  await dialog.locator("summary").filter({ hasText: "来源快照" }).click();
  assert.ok((await dialog.textContent()).includes("Shipping costs 12 coins"));
  await page.screenshot({ path: path.join(evidence, "library-source-snapshot.png") });
  pass("reindex/delete use inline actions; prepared sources survive original deletion");
  await dialog.getByRole("button", { name: "删除记录", exact: true }).click();
  await dialog.getByRole("button", { name: "删除记录", exact: true }).last().click();
  await dialog.getByText("还没有准备过问答。", { exact: true }).waitFor();
  assert.equal((await json("/conversations")).conversations.length, 1);
  pass("deleting a saved question frees its record while preserving its chat");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await more("基于此范围提问");
  await page.getByRole("dialog").getByLabel("问题", { exact: true }).fill("private draft");
  await page.evaluate(() => window.libraryTest.account());
  await page.waitForFunction(() => window.libraryTest.draft().question === null);
  assert.equal(await page.getByRole("dialog").count(), 0);
  pass("identity changes clear drafts and close old-account forms");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    JSON.stringify({ checks, errors, unexpected, requests }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, evidence }));
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
}
