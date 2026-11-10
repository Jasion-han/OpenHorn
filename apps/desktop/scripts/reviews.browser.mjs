import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence =
  process.env.OPENHORN_REVIEWS_EVIDENCE || path.join(os.tmpdir(), "openhorn-reviews-evidence");
await mkdir(evidence, { recursive: true });
const child = spawn(
  "bun",
  [path.join(desktop, "../server/src/routes/reviewWorkspaces.browser-fixture.ts")],
  {
    cwd: path.join(desktop, "../server"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "file::memory:",
      OPENHORN_TEST_DATABASE_URL: "file::memory:",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
let browser, server;
const checks = [],
  errors = [],
  unexpected = [],
  requests = [];
const pass = (text) => {
  checks.push(text);
  console.log(`PASS ${text}`);
};
try {
  const api = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Test backend startup timed out: ${stderr}`)),
      15000,
    );
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      for (const line of text.split("\n")) {
        try {
          const data = JSON.parse(line);
          if (data.url) {
            clearTimeout(timeout);
            resolve(data.url);
          }
        } catch {}
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Test backend exited ${code}: ${stderr}`));
    });
  });
  process.env.VITE_API_BASE = api;
  process.chdir(desktop);
  server = await createServer({
    root: desktop,
    configFile: path.join(desktop, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: 24000 + Math.floor(Math.random() * 10000),
      strictPort: true,
      watch: null,
      hmr: false,
    },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.fixtureIpc = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: async (command, args) => {
        window.fixtureIpc.push({ command, args });
        if (command === "save_attachment") return null;
        throw new Error(`Unexpected IPC ${command}`);
      },
    };
  });
  let holdList = null,
    enteredList;
  let holdVerification = null,
    enteredVerification;
  let holdPrepare = null,
    enteredPrepare;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) {
      unexpected.push(url.href);
      return route.abort();
    }
    requests.push({ path: url.pathname, method: route.request().method() });
    if (
      url.pathname.endsWith("/verify-note") &&
      route.request().method() === "POST" &&
      holdVerification
    ) {
      enteredVerification?.();
      await holdVerification;
    }
    if (url.pathname === "/review-workspaces" && route.request().method() === "GET" && holdList) {
      enteredList?.();
      await holdList;
    }
    if (/\/runs$/.test(url.pathname) && route.request().method() === "POST" && holdPrepare) {
      enteredPrepare?.();
      await holdPrepare;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const projectAction = async (name) => {
    await page.getByRole("button", { name: "更多评论项目操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  const openSettings = async () => {
    if ((await page.getByLabel("分析方式", { exact: true }).count()) === 0) {
      await page.getByRole("button", { name: "更多分析操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "筛选与分析设置", exact: true }).click();
    }
  };
  const openRuns = async () => {
    const records = page.getByTestId("review-runs");
    if ((await records.getAttribute("open")) === null) await records.locator("summary").click();
  };

  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/reviews.html`);
  await page.getByRole("heading", { name: "把评论变成可以持续使用的资料" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "导入 CSV", exact: true }).count(), 1);
  assert.equal(await page.getByRole("combobox", { name: "选择评论项目", exact: true }).count(), 0);
  pass("empty review workspace exposes one import action without an empty project selector");
  await page.getByRole("button", { name: "导入 CSV", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("评论 CSV 文件")
    .setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from([0xff, 0xff]) });
  await dialog
    .getByText("文件不是有效的 UTF-8 文本，请转换编码后重试。", { exact: true })
    .waitFor();
  const csv = 'text,rating\r\n"Good, but slow",4\r\n"  =1+1",1\r\n"Bad\nshipping",2\r\n';
  await dialog
    .getByLabel("评论 CSV 文件")
    .setInputFiles({ name: "feedback.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await dialog.getByLabel("项目名称").fill("Browser review project");
  await dialog.getByLabel("评分列（可选）").selectOption("1");
  await dialog
    .getByText("可导入 3 条，跳过 0 条空正文。以下展示前 5 条。", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("alert", { name: "放弃未保存的修改？", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "保存评论项目", exact: true }).click();
  await page.getByRole("heading", { name: "Browser review project" }).waitFor();
  const workspaces = await fetch(`${api}/review-workspaces`).then((r) => r.json());
  const workspaceId = workspaces.workspaces[0].id;
  pass("real CSV import validates UTF-8, previews quoted data and persists the original in SQLite");
  assert.equal(await page.getByLabel("聊天分析模型", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("分析方式", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "导出", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "刷新已保存数据", exact: true }).count(), 0);
  assert.equal(await page.getByTestId("review-runs").getAttribute("open"), null);
  pass("review defaults hide filters, model settings, import/export controls and analysis records");
  await openSettings();
  await page.getByLabel("聊天分析模型", { exact: true }).waitFor();
  const analysisRequests = requests.length;
  await page.getByLabel("分析方式", { exact: true }).selectOption("jev");
  assert.equal(await page.getByLabel("聊天分析模型", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "选择下一批未标注", exact: true }).count(),
    1,
  );
  await page.getByLabel("分析方式", { exact: true }).selectOption("chat");
  assert.equal(requests.length, analysisRequests);
  await page.getByRole("button", { name: "更多评论项目操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "导出全部标注 CSV", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "删除评论项目", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  pass("chat model selection belongs to chat analysis and deletion is separated from exports");

  await page.getByRole("textbox", { name: "搜索评论或主题" }).fill("missing review");
  await page.getByText("没有符合筛选条件的评论。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除筛选" }).click();
  assert.equal(await page.getByRole("checkbox", { name: /选择评论/ }).count(), 3);
  const runsBeforeSelection = requests.filter((request) => /\/runs$/.test(request.path)).length;
  await page.getByRole("button", { name: "选择下一批未标注" }).click();
  assert.equal(
    requests.filter((request) => /\/runs$/.test(request.path)).length,
    runsBeforeSelection,
  );
  pass(
    "the first primary click only selects a batch and a separate explicit click prepares analysis",
  );
  await page.getByRole("button", { name: "准备聊天分析", exact: true }).click();
  await page.getByTestId("handoff").waitFor();
  const pending = await page.evaluate(() => window.reviewsTest.pending());
  assert.equal(pending.autoSend, false);
  assert.ok(pending.text.includes("Good, but slow"));
  assert.equal(await page.evaluate(() => window.reviewsTest.mode()), "chat");
  assert.equal(
    requests.some((r) => /prepare-chat|\/chat$|\/regenerate/.test(r.path)),
    false,
  );
  pass(
    "batch preparation uses the real conversation handoff in Chat mode without invoking a model",
  );
  await page.getByRole("button", { name: "Back fixture" }).click();
  await openRuns();
  await page.getByRole("button", { name: "同步分析结果", exact: true }).click();
  await page
    .getByText("分析回复尚未完成或保存，或来源已删除。请打开会话检查后重试。", { exact: true })
    .waitFor();
  await fetch(`${api}/__fixture/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, bad: true }),
  });
  await openRuns();
  await page.getByRole("button", { name: "同步分析结果", exact: true }).click();
  await page
    .getByText("结果格式、评论 ID 或原文证据不符合要求，整批未导入。请在分析会话修正后再次同步。", {
      exact: true,
    })
    .waitFor();

  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByLabel("情绪", { exact: true }).selectOption("mixed");
  await dialog.getByLabel("主题", { exact: true }).fill("human topic");
  await dialog.getByLabel("原文证据", { exact: true }).fill("slow");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  await fetch(`${api}/__fixture/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  await openRuns();
  await page.getByRole("button", { name: "同步分析结果", exact: true }).click();
  await page.getByText("应用 2 条，跳过 1 条后续修改。", { exact: true }).waitFor();
  assert.equal(await page.getByText("human topic", { exact: true }).count(), 1);
  pass(
    "real API rejects unfinished/wrong-batch output and preserves manual edits when applying the batch",
  );

  await projectAction("导出全部标注 CSV");
  await page.waitForFunction(() => window.fixtureIpc.length > 0);
  const exported = await page.evaluate(() => window.fixtureIpc.at(-1).args);
  const exportedText = new TextDecoder().decode(new Uint8Array(exported.bytes));
  assert.ok(exportedText.includes("'  =1+1"));
  assert.ok(exportedText.includes("human topic"));
  await projectAction("导出原始 CSV");
  await page.waitForFunction(() => window.fixtureIpc.length === 2);
  const original = await page.evaluate(() => window.fixtureIpc.at(-1).args.bytes);
  assert.equal(new TextDecoder().decode(new Uint8Array(original)), csv);
  await projectAction("导出证据报告 Markdown");
  await page.waitForFunction(() => window.fixtureIpc.length === 3);
  const report = await page.evaluate(() => window.fixtureIpc.at(-1).args.bytes);
  assert.ok(new TextDecoder().decode(new Uint8Array(report)).includes("# Browser review project"));
  pass(
    "native save dispatch exports complete original bytes, formula-safe labeled CSV and an evidence report",
  );
  await page.reload();
  await openRuns();
  await page.getByText("应用 2 条，跳过 1 条后续修改。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByLabel("标注说明", { exact: true }).fill("unsaved draft");
  await fetch(`${api}/__fixture/conflict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog
    .getByText("已有较新的修改，本次没有覆盖。编辑内容仍在，请核对最新数据后重试。", {
      exact: true,
    })
    .waitFor();
  assert.equal(await dialog.getByLabel("标注说明", { exact: true }).inputValue(), "unsaved draft");
  await page.keyboard.press("Escape");
  await page.getByRole("alert", { name: "放弃未保存的修改？", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await projectAction("刷新已保存数据");
  pass("reload retains datasets/results and a stale manual write preserves its draft on conflict");
  let releaseList;
  holdList = new Promise((resolve) => {
    releaseList = resolve;
  });
  const listEntered = new Promise((resolve) => {
    enteredList = resolve;
  });
  await projectAction("刷新已保存数据");
  await listEntered;
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByLabel("标注说明", { exact: true }).fill("Saved during a pending refresh");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: "更多评论项目操作", exact: true }).isEnabled(),
    true,
  );
  const listResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/review-workspaces" &&
      response.request().method() === "GET",
  );
  releaseList();
  holdList = null;
  await (await listResponse).finished();
  assert.equal(
    await page.getByRole("combobox", { name: "选择评论项目", exact: true }).isEnabled(),
    true,
  );
  pass(
    "a successful write settles a superseded list spinner and a late refresh cannot lock the workspace",
  );
  const liveJev = process.env.OPENHORN_REVIEW_LIVE_JEV === "1";
  const mode = (value) =>
    fetch(`${api}/__fixture/verification-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: value }),
    });
  const stats = () => fetch(`${api}/__fixture/verification-stats`).then((r) => r.json());
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByLabel("标注说明", { exact: true }).fill("客服承诺终身免费换新。");
  assert.equal(await dialog.getByRole("button", { name: "用 Jev 核对说明" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog.getByText("建议复核说明", { exact: true }).waitFor();
  let verificationState = await stats();
  assert.equal(verificationState.calls.length, 1);
  assert.deepEqual(Object.keys(verificationState.calls[0].payload.questions).sort(), [
    "hasClaims",
    "note",
  ]);
  const negativeCheck = verificationState.calls[0];
  assert.ok(negativeCheck.response.answers.note.noul <= 0.3);
  assert.deepEqual(Object.keys(negativeCheck.payload.state).sort(), ["annotation", "review"]);
  assert.deepEqual(Object.keys(negativeCheck.payload.state.annotation), ["note"]);
  assert.equal(negativeCheck.payload.state.review.text, "Good, but slow");
  await dialog.getByText("查看核对请求内容", { exact: true }).click();
  assert.ok((await dialog.locator("pre").textContent()).includes("客服承诺终身免费换新。"));
  await page.screenshot({ path: path.join(evidence, "jev-note-needs-review.png"), fullPage: true });
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog.getByText("复用已保存的检查结果，本次未再次调用模型。", { exact: true }).waitFor();
  assert.equal((await stats()).calls.length, 1);
  // This save must use the revision returned by the dialog's own successful verification.
  await dialog.getByLabel("标注说明", { exact: true }).fill("评论认可使用体验，同时指出速度慢。");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  const cleared = await fetch(`${api}/review-workspaces/${workspaceId}`).then((r) => r.json());
  assert.equal(cleared.workspace.data.rows[0].noteVerification, undefined);
  if (!liveJev) await mode("positive");
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog.getByText("未发现明显冲突", { exact: true }).waitFor();
  verificationState = await stats();
  assert.equal(verificationState.calls.length, 2);
  assert.ok(verificationState.calls[1].response.answers.note.noul >= 0.7);
  assert.equal(verificationState.liveProviderCalls, liveJev ? 2 : 0);
  await page.screenshot({ path: path.join(evidence, "jev-note-supported.png"), fullPage: true });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  pass(
    liveJev
      ? "actual production route and SQLite persist two real Jev judgments, cache reuse and annotation invalidation"
      : "note checks display support/review signals, reveal the exact minimal payload and reuse a saved result without another call",
  );
  await fetch(`${api}/__fixture/legacy-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, rowId: "r2" }),
  });
  await page.reload();
  await page.getByRole("heading", { name: "Browser review project" }).waitFor();
  await page.getByRole("button", { name: "查看与修正 r2" }).click();
  await dialog
    .getByText("这是旧版规则的检查结果；主动重查可使用新规则。", { exact: true })
    .waitFor();
  assert.equal((await stats()).calls.length, 2);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  pass("historical v1 records remain readable without triggering a paid upgrade");
  await page.getByRole("button", { name: "查看与修正 r3" }).click();
  await dialog.getByLabel("标注说明", { exact: true }).fill("建议联系售后处理。");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  const liveNoClaims = liveJev && process.env.OPENHORN_REVIEW_LIVE_JEV_MAX_CALLS === "3";
  if (!liveNoClaims) await mode("no-claims");
  await page.getByRole("button", { name: "查看与修正 r3" }).click();
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog.getByText("没有可核对事实", { exact: true }).waitFor();
  assert.equal(await dialog.getByText(/原文支持说明的概率/).count(), 0);
  verificationState = await stats();
  assert.equal(verificationState.calls.length, 3);
  assert.equal(verificationState.liveProviderCalls, liveNoClaims ? 3 : liveJev ? 2 : 0);
  assert.ok(verificationState.calls[2].response.answers.hasClaims.noul <= 0.3);
  await page.screenshot({
    path: path.join(evidence, "jev-note-not-applicable.png"),
    fullPage: true,
  });
  await dialog.getByLabel("标注说明", { exact: true }).fill("用户说设备不能使用。");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  pass(
    liveNoClaims
      ? "the production API calls Jev and stores not-applicable for a pure recommendation"
      : "pure recommendations show not-applicable and never display a misleading support percentage",
  );
  // Error paths are controlled fixtures even during the explicit live test run.
  await page.getByRole("button", { name: "查看与修正 r3" }).click();
  await mode("error");
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog
    .getByText("Jev 核对不可用。请检查服务端 Jev 配置和连接。标注未改变。", {
      exact: true,
    })
    .waitFor();
  await mode("timeout");
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog
    .getByText("Jev 请求超时，本次没有检查结果；没有自动重试。", { exact: true })
    .waitFor();
  await mode("uncertain");
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog.getByText("判断不确定", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  verificationState = await stats();
  assert.equal(verificationState.calls.length, 6);
  await page.getByRole("button", { name: "查看与修正 r3" }).click();
  await dialog.getByLabel("标注说明", { exact: true }).fill("另一条需要核对的说明。");
  await dialog.getByRole("button", { name: "保存人工修正" }).click();
  await dialog.waitFor({ state: "hidden" });
  await mode("unclear-claims");
  await page.getByRole("button", { name: "查看与修正 r3" }).click();
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await dialog
    .getByText("暂时无法确定说明是否包含可核对事实，请人工判断。", { exact: true })
    .waitFor();
  assert.equal(await dialog.getByText(/原文支持说明的概率/).count(), 0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  pass("uncertain factual existence hides even a 99-percent support answer");
  await mode("positive");
  await page.getByRole("button", { name: "查看与修正 r4" }).click();
  let releaseVerification;
  holdVerification = new Promise((resolve) => {
    releaseVerification = resolve;
  });
  const verificationEntered = new Promise((resolve) => {
    enteredVerification = resolve;
  });
  await dialog.getByRole("button", { name: "用 Jev 核对说明" }).click();
  await verificationEntered;
  await page.evaluate(() => window.reviewsTest.leave());
  const lateVerificationResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/verify-note") &&
      response.request().method() === "POST",
  );
  releaseVerification();
  holdVerification = null;
  await (await lateVerificationResponse).finished();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.getByTestId("handoff").count(), 1);
  assert.equal(await page.evaluate(() => window.reviewsTest.pending()), null);
  await page.evaluate(() => window.reviewsTest.back());
  await page.getByRole("heading", { name: "Browser review project" }).waitFor();
  pass(
    "a verification response arriving after navigation cannot install an old dialog or change the current view",
  );
  verificationState = await stats();
  assert.equal(verificationState.calls.length, 8);
  await writeFile(
    path.join(evidence, "jev-verifications.json"),
    JSON.stringify(verificationState, null, 2),
  );
  pass(
    "provider errors and timeouts never become negative answers and intermediate probabilities remain uncertain",
  );
  await page.screenshot({ path: path.join(evidence, "reviews-light.png"), fullPage: true });
  await page.setViewportSize({ width: 680, height: 900 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  // Existing buttons animate theme colors; capture their settled palette.
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, "reviews-dark-narrow.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  pass("light desktop and narrow dark layouts retain the controls without document overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fetch(`${api}/__fixture/delete-source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  await openRuns();
  await page.getByRole("button", { name: "打开分析会话", exact: true }).click();
  await page
    .getByText("分析回复尚未完成或保存，或来源已删除。请打开会话检查后重试。", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("heading", { name: "Browser review project" }).count(), 1);
  pass("a deleted source reports a recoverable error while the saved analysis stays available");
  await page.getByRole("checkbox", { name: "选择评论 r2", exact: true }).check();
  let release;
  holdPrepare = new Promise((done) => {
    release = done;
  });
  const entered = new Promise((done) => {
    enteredPrepare = done;
  });
  await page.getByRole("button", { name: "准备聊天分析", exact: true }).click();
  await entered;
  await page.evaluate(() => window.reviewsTest.leave());
  const lateResponse = page.waitForResponse(
    (response) => /\/runs$/.test(response.url()) && response.request().method() === "POST",
  );
  release();
  holdPrepare = null;
  await (await lateResponse).finished();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.evaluate(() => window.reviewsTest.pending()), null);
  pass("a late prepare response cannot navigate or fill a draft after the user leaves");
  await page.evaluate(() => window.reviewsTest.back());
  await page.getByRole("heading", { name: "Browser review project" }).waitFor();
  const latest = await fetch(`${api}/review-workspaces/${workspaceId}`).then((r) => r.json());
  await fetch(`${api}/review-workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Other client project",
      csv: "text\nAnother comment",
      fileName: "other.csv",
      delimiter: ",",
      textColumn: 0,
      ratingColumn: null,
    }),
  });
  await fetch(`${api}/review-workspaces/${workspaceId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: latest.workspace.revision }),
  });
  await projectAction("刷新已保存数据");
  await page.getByRole("heading", { name: "Other client project" }).waitFor();
  assert.equal(
    await page.getByRole("option", { name: "Browser review project", exact: true }).count(),
    0,
  );
  pass("refresh recovers from a remotely deleted selection and discovers another client's dataset");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    JSON.stringify({ checks, errors, unexpected, requests }, null, 2),
  );
  console.log(`Evidence: ${evidence}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
}
