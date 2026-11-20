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
  let failLibraryUpload = false;
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
    if (
      failLibraryUpload &&
      url.pathname === "/library" &&
      request.method() === "POST" &&
      request.postDataBuffer()?.includes(Buffer.from('filename="batch-two.md"'))
    ) {
      failLibraryUpload = false;
      return route.fulfill({ status: 413, json: { errorCode: "library_storage_limit" } });
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
    await view.locator("header").getByRole("button", { name: "导入资料", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("选择文件")
      .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
    await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await view.getByRole("heading", { name, exact: true }).waitFor();
  };
  await view.getByText("还没有资料", { exact: true }).waitFor();
  assert.ok((await view.textContent()).includes("当前范围已存储 0/100 份"));
  assert.equal(await page.getByRole("button", { name: "重建索引", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "下载原件", exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidence, "library-empty.png") });
  pass("existing Library entry opens a quiet empty view with secondary actions hidden");
  await view.locator("header").getByRole("button", { name: "导入资料", exact: true }).click();
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
  assert.ok((await view.textContent()).includes("当前范围已存储 1/100 份"));
  await view.getByRole("button", { name: /shipping.md/ }).click();
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  pass("text imports and same-document re-selection show escaped original text");
  await upload(
    "shipping.md",
    "# Shipping\nShipping costs 12 coins. Returns take 7 days.\n<script>window.libraryUnsafe=true</script>",
  );
  assert.equal((await json("/library")).documents.length, 1);
  pass("duplicate upload reuses one original document and closes the form");
  await upload("shipping.md", "# Shipping v2\nUpdated shipping costs.");
  const versionRows = await json(`/library/${firstId}/versions`);
  assert.deepEqual(
    versionRows.versions.map((row) => row.version),
    [2, 1],
  );
  await more("历史版本");
  dialog = page.getByRole("dialog");
  await dialog.getByText("版本 2", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "恢复此版本", exact: true }).click();
  await dialog.getByRole("button", { name: "确认恢复", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await view.getByText("Shipping costs 12 coins.", { exact: false }).waitFor();
  assert.ok((await view.textContent()).includes("Shipping costs 12 coins"));
  pass("same-name uploads keep a visible version history and restore an older version");
  await view.getByLabel("资料范围").selectOption(`project:${project.id}`);
  await view.getByText("还没有资料", { exact: true }).waitFor();
  await upload("project.txt", "Shipping project only 55 coins.");
  await view.getByLabel("资料范围").selectOption("personal");
  await view.getByRole("heading", { name: "shipping.md", exact: true }).waitFor();
  assert.equal(await view.getByRole("button", { name: /project.txt/ }).count(), 0);
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("shipping");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view.getByRole("complementary", { name: "检索结果", exact: true }).waitFor();
  assert.ok((await view.textContent()).includes("片段 1"));
  assert.ok(
    (
      await view.getByRole("complementary", { name: "检索结果", exact: true }).textContent()
    ).includes("Shipping"),
  );
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
  await view.getByRole("complementary", { name: "检索结果", exact: true }).waitFor();
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
  await dialog.getByRole("button", { name: "打开草稿", exact: true }).click();
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
  await dialog.getByRole("button", { name: "打开草稿", exact: true }).dblclick({ delay: 10 });
  await page.getByTestId("handoff").getByText("shipping", { exact: true }).waitFor();
  const pending = await page.evaluate(() => window.libraryTest.pending());
  assert.equal(pending.autoSend, false);
  assert.match(pending.librarySources[0].text, /Shipping costs 12 coins/);
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
  await view.getByRole("complementary", { name: "检索结果", exact: true }).waitFor();
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
  assert.equal(await view.getByRole("complementary", { name: "检索结果", exact: true }).count(), 0);
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
  await view.getByRole("button", { name: /shipping.md/ }).waitFor();
  await more("删除资料");
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
  const beforeBatch = (await json("/library")).stats.documents;
  const openUpload = () =>
    view.locator("header").getByRole("button", { name: "导入资料", exact: true }).click();
  const batchFile = (name) => ({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`Text ${name}`),
  });
  await openUpload();
  dialog = page.getByRole("dialog");
  const picker = dialog.getByLabel("选择文件");
  await picker.setInputFiles([batchFile("batch-one.md"), batchFile("unsupported.exe")]);
  await dialog.getByRole("alert").filter({ hasText: "unsupported.exe" }).waitFor();
  const drop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Batch two"], "batch-two.md", { type: "text/plain" }));
    transfer.items.add(new File(["Batch three"], "batch-three.md", { type: "text/plain" }));
    return transfer;
  });
  await dialog.getByText("可多选或拖入").dispatchEvent("drop", { dataTransfer: drop });
  await drop.dispose();
  await picker.setInputFiles([]);
  assert.deepEqual(await dialog.getByRole("listitem").count(), 3);
  await dialog.getByText("待导入 3 份", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(evidence, "library-batch-queue.png"),
    animations: "disabled",
  });
  failLibraryUpload = true;
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "batch-two.md" }).waitFor();
  assert.equal(await dialog.getByRole("status").textContent(), "已导入 1/3 份");
  assert.deepEqual(await dialog.getByRole("listitem").count(), 2);
  assert.equal((await json("/library")).stats.documents, beforeBatch + 1);
  await page.screenshot({
    path: path.join(evidence, "library-batch-partial.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  for (const name of ["batch-one.md", "batch-two.md", "batch-three.md"]) {
    await view.getByRole("button", { name: new RegExp(name) }).waitFor();
  }
  const afterBatch = (await json("/library")).stats.documents;
  assert.equal(afterBatch, beforeBatch + 3);
  await view.getByText(new RegExp(`当前范围已存储 ${afterBatch}/100 份`)).waitFor();
  pass(
    "multi-select and drop import valid files, stop on failure and resume without resending successes",
  );

  await openUpload();
  dialog = page.getByRole("dialog");
  await picker.setInputFiles([batchFile("pause-one.md"), batchFile("pause-two.md")]);
  const pauseStarted = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    release = resolve;
  });
  matchHold = (url, request) => url.pathname === "/library" && request.method() === "POST";
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await pauseStarted;
  await dialog.getByRole("button", { name: "暂停导入", exact: true }).click();
  release();
  hold = null;
  await dialog.getByText("已导入 1/2 份", { exact: true }).waitFor();
  assert.equal((await json("/library")).stats.documents, afterBatch + 1);
  await dialog.getByRole("button", { name: "移除 pause-two.md", exact: true }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  pass("pause lets the current file finish and leaves only the remaining file queued");

  await openUpload();
  await picker.setInputFiles([batchFile("leave-one.md"), batchFile("leave-two.md")]);
  const leaveStarted = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    release = resolve;
  });
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await leaveStarted;
  await page.evaluate(() => window.libraryTest.leave());
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await openUpload();
  await dialog.getByText("正在完成当前文件…", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "导入资料", exact: true }).isDisabled(),
    true,
  );
  release();
  hold = null;
  await dialog.getByText("leave-one.md", { exact: true }).waitFor({ state: "hidden" });
  await dialog.getByText("leave-two.md", { exact: true }).waitFor();
  const afterLeave = await json("/library");
  assert.equal(
    afterLeave.documents.some((row) => row.fileName === "leave-two.md"),
    false,
  );
  await dialog.getByRole("button", { name: "移除 leave-two.md", exact: true }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await view.getByRole("button", { name: /leave-one\.md/ }).waitFor();
  pass("returning to the Library waits for the active receipt without sending the same file twice");

  await upload("metadata.md", "# Metadata\nProject reference.");
  await view.getByText("编辑资料信息", { exact: true }).click();
  await view.getByLabel("资料名称", { exact: true }).fill("Saved notes");
  await view.getByLabel("标签", { exact: true }).fill("work, notes");
  await view.getByRole("button", { name: "收藏资料", exact: true }).click();
  await view.getByRole("button", { name: "取消收藏", exact: true }).waitFor();
  assert.equal(await view.getByLabel("资料名称", { exact: true }).inputValue(), "Saved notes");
  assert.equal(
    (await json("/library")).documents.find((row) => row.fileName === "metadata.md").displayName,
    "metadata.md",
  );
  await view.getByRole("button", { name: "保存资料信息", exact: true }).click();
  await view.getByRole("heading", { name: "Saved notes", exact: true }).waitFor();
  await view.getByRole("button", { name: "标签筛选", exact: true }).press("ArrowDown");
  await page.getByRole("menuitem", { name: "全部标签", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "work", exact: true }).hover();
  await page.screenshot({
    path: path.join(evidence, "library-organization-filter.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "work", exact: true }).click();
  await view.getByRole("button", { name: /batch-one.md/ }).waitFor({ state: "hidden" });
  await view.getByRole("button", { name: "仅收藏", exact: true }).click();
  await view.getByRole("button", { name: /Saved notes/ }).waitFor();
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("Saved notes");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view
    .getByRole("complementary", { name: "检索结果", exact: true })
    .getByRole("button", { name: /Saved notes/ })
    .waitFor();
  await view.getByRole("button", { name: "清除检索", exact: true }).click();
  await view.getByRole("button", { name: "取消收藏", exact: true }).click();
  await view.getByText("当前范围没有符合筛选条件的资料。", { exact: true }).waitFor();
  await view.getByRole("button", { name: "清除筛选", exact: true }).click();
  await view.getByRole("button", { name: /batch-one.md/ }).waitFor();
  await view.getByRole("button", { name: "仅收藏", exact: true }).click();
  await view.getByText("当前范围没有符合筛选条件的资料。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "统一搜索", exact: true }).click();
  await page.getByRole("textbox", { name: "统一搜索", exact: true }).fill("Saved notes");
  await page.locator('[data-search-kind="library"]').filter({ hasText: "Saved notes" }).click();
  await view.getByRole("heading", { name: "Saved notes", exact: true }).waitFor();
  pass(
    "display names, tags and favorites persist independently and filter the current Library scope",
  );

  await view.getByRole("button", { name: "文件夹", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建文件夹", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("文件夹名称", { exact: true }).fill("Research");
  await dialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await upload("foldered.md", "# Foldered\nResearch material.");
  await view.getByRole("heading", { name: "foldered.md", exact: true }).waitFor();
  await view.getByRole("button", { name: "文件夹", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除文件夹", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "删除文件夹", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await view.getByRole("button", { name: "文件夹", exact: true }).waitFor();
  pass(
    "folders create, receive new imports and return their documents to Uncategorized on deletion",
  );

  await view.getByRole("button", { name: "文件夹", exact: true }).press("ArrowDown");
  await page.getByRole("menuitem", { name: "新建文件夹", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("文件夹名称", { exact: true }).fill("Archive");
  await dialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const folderFilter = view.getByRole("button", { name: "文件夹", exact: true });
  await folderFilter.click();
  await page.getByRole("menuitem", { name: "未分类", exact: true }).click();
  const bulkQuery = view.getByRole("textbox", { name: "检索资料", exact: true });
  await bulkQuery.fill("batch");
  await bulkQuery.press("Enter");
  const bulkResults = view.getByRole("complementary", { name: "检索结果", exact: true });
  await bulkResults.getByRole("button", { name: /batch-one.md/ }).waitFor();
  const bulkMode = bulkResults.getByRole("button", { name: "批量整理", exact: true });
  await bulkMode.press("Enter");
  const bulkMove = bulkResults.getByRole("button", { name: "移动到文件夹", exact: true });
  assert.equal(await bulkMove.isDisabled(), true);
  await bulkResults
    .getByRole("checkbox", { name: "选择 batch-one.md", exact: true })
    .press("Space");
  await bulkResults.getByRole("checkbox", { name: "选择 batch-two.md", exact: true }).click();
  await bulkResults.getByText("已选 2 份", { exact: true }).waitFor();
  const bulkRequestTotal = () =>
    requests.filter((r) => r.path === "/library/documents/move" && r.method === "POST").length;
  const movesBefore = bulkRequestTotal();
  await bulkMove.press("ArrowDown");
  const destination = page.getByRole("menuitem", { name: "Archive", exact: true });
  await destination.hover();
  await page.screenshot({
    path: path.join(evidence, "library-bulk-move-menu.png"),
    animations: "disabled",
  });
  await destination.press("Enter");
  await page.getByText("已移动 2 份资料", { exact: true }).waitFor();
  await bulkResults.getByRole("button", { name: /batch-one.md/ }).waitFor({ state: "hidden" });
  assert.equal(bulkRequestTotal(), movesBefore + 1);
  assert.equal(await bulkQuery.inputValue(), "batch");
  await folderFilter.click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await bulkResults.getByText("找到 2 份资料", { exact: true }).waitFor();
  await bulkMode.click();
  await bulkResults.getByRole("button", { name: "全选当前列表", exact: true }).click();
  await bulkResults.getByText("已选 2 份", { exact: true }).waitFor();
  await bulkMove.click();
  await page.getByRole("menuitem", { name: "未分类", exact: true }).click();
  await bulkResults.getByRole("button", { name: /batch-one.md/ }).waitFor({ state: "hidden" });
  assert.equal(bulkRequestTotal(), movesBefore + 2);
  assert.equal(
    (await json("/library")).documents.filter(
      (doc) => ["batch-one.md", "batch-two.md"].includes(doc.fileName) && doc.folderId === null,
    ).length,
    2,
  );
  await folderFilter.click();
  await page.getByRole("menuitem", { name: "全部文件夹", exact: true }).click();
  pass("bulk moves selected search results to a folder and all visible hits back to Uncategorized");

  const archiveId = (await json("/library")).folders.find((folder) => folder.name === "Archive").id;
  await openUpload();
  dialog = page.getByRole("dialog");
  await picker.setInputFiles([batchFile("destination-one.md"), batchFile("destination-two.md")]);
  const destinationPicker = dialog.getByRole("button", { name: "目标文件夹", exact: true });
  assert.match(await destinationPicker.textContent(), /未分类/);
  await destinationPicker.press("ArrowDown");
  await page.getByRole("menuitem", { name: "Archive", exact: true }).hover();
  await page.screenshot({
    path: path.join(evidence, "library-import-destination-menu.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Archive", exact: true }).press("Enter");
  assert.match(await destinationPicker.textContent(), /Archive/);
  const destinationStarted = new Promise((resolve) => {
    entered = resolve;
  });
  hold = new Promise((resolve) => {
    release = resolve;
  });
  matchHold = (url, request) => url.pathname === "/library" && request.method() === "POST";
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await destinationStarted;
  assert.equal(await destinationPicker.isDisabled(), true);
  await page.evaluate(() => window.libraryTest.leave());
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await openUpload();
  await dialog.getByText("正在完成当前文件…", { exact: true }).waitFor();
  await destinationPicker.filter({ hasText: "Archive" }).waitFor();
  assert.equal(await destinationPicker.isDisabled(), true);
  release();
  hold = null;
  await dialog.getByText("destination-one.md", { exact: true }).waitFor({ state: "hidden" });
  await dialog.getByText("destination-two.md", { exact: true }).waitFor();
  await destinationPicker.click();
  const savedDestination = page.getByRole("menuitem", { name: "Archive", exact: true });
  assert.equal(await savedDestination.getAttribute("aria-current"), "true");
  await page.screenshot({
    path: path.join(evidence, "library-import-destination-resume.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "未分类", exact: true }).click();
  await dialog.getByRole("button", { name: "导入资料", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const importedByDestination = (await json("/library")).documents;
  assert.equal(
    importedByDestination.find((doc) => doc.fileName === "destination-one.md").folderId,
    archiveId,
  );
  assert.equal(
    importedByDestination.find((doc) => doc.fileName === "destination-two.md").folderId,
    null,
  );
  pass(
    "upload keeps its chosen destination across navigation and retargets only the remaining file",
  );

  const { libraryTestPdf } = await import("../../server/src/routes/libraryPdf.fixture.ts");
  await upload(
    "physical-page.pdf",
    libraryTestPdf(2, (index) => (index ? "Traceable paragraph" : "")),
  );
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("Traceable");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view.getByRole("button", { name: "查看 PDF 第 2 页", exact: true }).click();
  const pdfPreview = page.getByRole("dialog", { name: "PDF 原件" });
  await pdfPreview.getByText("2 / 2", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[role="dialog"] canvas');
    if (!canvas || canvas.width !== 612 || canvas.height !== 792) return false;
    const context = canvas.getContext("2d");
    return (
      context.getImageData(0, 0, 1, 1).data[0] === 255 &&
      context
        .getImageData(35, 30, 120, 25)
        .data.some((value, index) => index % 4 !== 3 && value < 128)
    );
  });
  await page.screenshot({
    path: path.join(evidence, "library-provenance-pdf.png"),
    animations: "disabled",
  });
  await pdfPreview.getByRole("button", { name: "Close", exact: true }).click();
  await more("基于此范围提问");
  await page.getByRole("dialog").getByLabel("问题", { exact: true }).fill("Traceable");
  await page.getByRole("button", { name: "打开草稿", exact: true }).click();
  await page.getByTestId("handoff").getByText("Traceable", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.libraryTest.pending())).librarySources[0].location.pageStart,
    2,
  );
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await more("问答记录");
  dialog = page.getByRole("dialog", { name: "问答记录" });
  await dialog.locator("summary").filter({ hasText: "来源快照" }).click();
  await dialog.getByRole("button", { name: "查看 PDF 第 2 页", exact: true }).click();
  await pdfPreview.getByText("2 / 2", { exact: true }).waitFor();
  await pdfPreview.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("Project reference");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await view.getByRole("button", { name: "在正文中定位", exact: true }).click();
  assert.equal(await view.locator("pre mark").textContent(), "# Metadata\nProject reference.");
  assert.equal(
    await view.locator("pre mark").evaluate((mark) => mark === document.activeElement),
    true,
  );
  pass(
    "PDF search and frozen sources open its physical page, and text search highlights the exact original section",
  );

  await upload("coverage.docx", "Stored original only.");
  await upload(
    "coverage-notes.md",
    "## First section\nCoverage first.\n\n## Second section\nＣＯＶＥＲＡＧＥ second.",
  );
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("coverage");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  const coverageResults = view.getByRole("complementary", { name: "检索结果", exact: true });
  await coverageResults.getByText("找到 2 份资料", { exact: true }).waitFor();
  await coverageResults.getByRole("button", { name: /coverage.docx.*文件名或标题匹配/ }).click();
  await view.getByRole("heading", { name: "coverage.docx", exact: true }).waitFor();
  await coverageResults.getByRole("button", { name: /coverage-notes.md.*匹配 2 个片段/ }).click();
  await view.getByText("第 1 / 2 个匹配片段", { exact: true }).waitFor();
  const nextHit = view.getByRole("button", { name: "下一个匹配片段", exact: true });
  await nextHit.press("Enter");
  await view.getByText("第 2 / 2 个匹配片段", { exact: true }).waitFor();
  await view.getByRole("heading", { name: /Second section.*第 4–5 行/ }).waitFor();
  await view.getByRole("button", { name: "在正文中定位", exact: true }).click();
  assert.equal(
    await view.locator("pre mark").textContent(),
    "## Second section\nＣＯＶＥＲＡＧＥ second.",
  );
  await view.getByRole("button", { name: "上一个匹配片段", exact: true }).hover();
  await page.screenshot({
    path: path.join(evidence, "library-search-matches.png"),
    animations: "disabled",
  });
  await view.getByRole("button", { name: "上一个匹配片段", exact: true }).click();
  await view.getByText("第 1 / 2 个匹配片段", { exact: true }).waitFor();
  pass(
    "search keeps title-only files and browses width-variant matches with exact source locations",
  );

  const askSource = view.getByRole("button", { name: "提问", exact: true });
  await view.getByLabel("资料范围").selectOption("all");
  await view.getByRole("textbox", { name: "检索资料", exact: true }).fill("coverage");
  await view.getByRole("button", { name: "检索资料", exact: true }).click();
  await coverageResults.getByRole("button", { name: /coverage-notes.md.*匹配 2 个片段/ }).click();
  await nextHit.press("Enter");
  await view.getByText("第 2 / 2 个匹配片段", { exact: true }).waitFor();
  await askSource.hover();
  await askSource.focus();
  await page.screenshot({
    path: path.join(evidence, "library-ask-source-entry.png"),
    animations: "disabled",
  });
  await askSource.press("Enter");
  dialog = page.getByRole("dialog", { name: "带来源提问" });
  await dialog.getByText("coverage-notes.md", { exact: true }).waitFor();
  await dialog.getByText("第 4–5 行 · 片段 2", { exact: true }).waitFor();
  await dialog.getByText("个人资料", { exact: true }).waitFor();
  const selectedPrompt = dialog.getByLabel("问题", { exact: true });
  await selectedPrompt.fill("Nonsuch interpretation?");
  await dialog.getByText(/模型选项/).click();
  const sourceModel = dialog.getByLabel("聊天模型", { exact: true });
  await sourceModel.focus();
  await page.screenshot({
    path: path.join(evidence, "library-ask-source-dialog.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "打开草稿", exact: true }).click();
  await page.getByTestId("handoff").getByText("Nonsuch interpretation?", { exact: true }).waitFor();
  const selectedDraft = await page.evaluate(() => window.libraryTest.pending());
  assert.equal(selectedDraft.autoSend, false);
  assert.equal(selectedDraft.text, "Nonsuch interpretation?");
  assert.equal(selectedDraft.librarySources.length, 1);
  assert.equal(selectedDraft.librarySources[0].text, "## Second section\nＣＯＶＥＲＡＧＥ second.");
  assert.equal(selectedDraft.librarySources[0].location.lineStart, 4);
  assert.equal(selectedDraft.librarySources[0].chunkIndex, 1);
  assert.equal((await json("/library/questions")).questions[0].scope.kind, "personal");
  assert.equal((await json("/__fixture/decision-stats")).calls, 0);
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await view.getByText("第 2 / 2 个匹配片段", { exact: true }).waitFor();
  await view.getByRole("heading", { name: /Second section.*第 4–5 行/ }).waitFor();
  const searchInput = view.getByRole("textbox", { name: "检索资料", exact: true });
  assert.equal(await view.getByLabel("资料范围").inputValue(), "all");
  assert.equal(await searchInput.inputValue(), "coverage");
  const coverageRow = coverageResults.getByRole("button", {
    name: /coverage-notes.md.*匹配 2 个片段/,
  });
  assert.equal(await coverageRow.getAttribute("aria-pressed"), "true");
  await coverageRow.focus();
  await page.screenshot({
    path: path.join(evidence, "library-resumed-match.png"),
    animations: "disabled",
  });
  pass("returning from a selected-source chat restores scope, query, document and second hit");

  const coverageDocument = (await json("/library")).documents.find(
    (row) => row.fileName === "coverage-notes.md",
  );
  await view.getByRole("button", { name: "收藏资料", exact: true }).click();
  await view.getByRole("button", { name: "取消收藏", exact: true }).waitFor();
  const favoriteFilter = view.getByRole("button", { name: "仅收藏", exact: true });
  await favoriteFilter.click();
  await searchInput.press("Enter");
  await coverageResults.getByText("找到 1 份资料", { exact: true }).waitFor();
  await nextHit.press("Enter");
  await view.getByText("第 2 / 2 个匹配片段", { exact: true }).waitFor();
  await page.evaluate(() => window.libraryTest.leave());
  await json(`/library/${coverageDocument.id}/index`, "POST");
  await page.getByRole("button", { name: "Back fixture", exact: true }).click();
  await view.getByText("第 1 / 2 个匹配片段", { exact: true }).waitFor();
  assert.equal(await favoriteFilter.getAttribute("aria-pressed"), "true");
  await coverageResults.getByText("找到 1 份资料", { exact: true }).waitFor();
  assert.equal(await coverageRow.getAttribute("aria-pressed"), "true");
  pass("return reads the new index with the saved filter and falls back to its current first hit");
  await view.getByLabel("资料范围").selectOption("personal");
  await searchInput.fill("coverage");
  await searchInput.press("Enter");
  await coverageResults.getByText("找到 2 份资料", { exact: true }).waitFor();

  await more("基于此范围提问");
  await page.getByRole("dialog").getByLabel("问题", { exact: true }).fill("private draft");
  await page.evaluate(() => window.libraryTest.account());
  await page.waitForFunction(() => window.libraryTest.draft().question === null);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await searchInput.inputValue(), "");
  assert.equal(await coverageResults.count(), 0);
  pass("identity changes clear browsing state and drafts and close old-account forms");
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
