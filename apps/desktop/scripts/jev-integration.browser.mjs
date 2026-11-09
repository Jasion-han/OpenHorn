import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = process.env.OPENHORN_JEV_EVIDENCE || "/tmp/openhorn-jev-integration-evidence";
await mkdir(evidence, { recursive: true });
const child = spawn(
  "bun",
  [path.join(desktop, "../server/src/routes/reviewWorkspaces.browser-fixture.ts")],
  {
    cwd: path.join(desktop, "../server"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OPENHORN_JEV_SYNTHETIC: "1",
      DATABASE_URL: "file::memory:",
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
    const timer = setTimeout(() => reject(new Error(`Fixture startup failed: ${stderr}`)), 15_000);
    let output = "";
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
      reject(new Error(`Fixture exited ${code}: ${stderr}`));
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
  const create = async (name, text) =>
    (
      await json("/review-workspaces", "POST", {
        title: name,
        csv: `text\n${text}`,
        fileName: "synthetic.csv",
        delimiter: ",",
        textColumn: 0,
        ratingColumn: null,
      })
    ).workspace;
  let workspace = await create("Jev synthetic project", "Easy to use\nWorks well");
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
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  let failConfig = false,
    held = null,
    entered;
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) {
      unexpected.push(url.href);
      return route.abort();
    }
    requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/decisions/config" && failConfig)
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    if (url.pathname.endsWith("/jev-runs") && held) {
      entered?.();
      await held;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/jev-integration.html`);
  await page.getByText("已配置 OpenRouter · Jev 1.14", { exact: true }).waitFor();
  const master = page.getByRole("switch", { name: "启用 Jev 辅助", exact: true });
  assert.equal(await master.getAttribute("aria-checked"), "true");
  assert.equal(await page.getByRole("switch").count(), 1);
  pass("Jev settings show configuration and daily budget with feature switches collapsed");
  await page.getByText("功能范围", { exact: true }).click();
  const reviewSwitch = page.getByRole("switch", { name: "评论快速标注与备注核验", exact: true });
  failConfig = true;
  await reviewSwitch.click();
  await page.getByText("保存失败，已保留原设置。", { exact: true }).waitFor();
  assert.equal(await reviewSwitch.getAttribute("aria-checked"), "true");
  failConfig = false;
  await reviewSwitch.click();
  await page.waitForFunction(
    () => document.querySelector("#jev-reviews")?.getAttribute("aria-checked") === "false",
  );
  await page.getByRole("button", { name: "Reviews fixture", exact: true }).click();
  await page.getByRole("heading", { name: workspace.title, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Jev 快速标注", exact: true }).isDisabled(),
    true,
  );
  pass(
    "failed preference writes preserve the old toggle; disabling reviews disables quick classification",
  );
  await page.getByRole("button", { name: "Settings fixture", exact: true }).click();
  await page.getByText("功能范围", { exact: true }).click();
  await reviewSwitch.click();
  await page.waitForFunction(
    () => document.querySelector("#jev-reviews")?.getAttribute("aria-checked") === "true",
  );
  await page.screenshot({ path: path.join(evidence, "jev-settings.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Reviews fixture", exact: true }).click();
  await page.getByRole("heading", { name: workspace.title, exact: true }).waitFor();
  await page.getByRole("button", { name: "选择下一批未标注", exact: true }).click();
  let release;
  const started = new Promise((done) => {
    entered = done;
  });
  held = new Promise((done) => {
    release = done;
  });
  const before = requests.filter((r) => r.path.endsWith("/jev-runs")).length;
  await page.getByRole("button", { name: "Jev 快速标注", exact: true }).dblclick({ delay: 10 });
  await started;
  assert.equal(
    await page.getByRole("button", { name: "Jev 快速标注", exact: true }).isDisabled(),
    true,
  );
  assert.equal(requests.filter((r) => r.path.endsWith("/jev-runs")).length, before + 1);
  release();
  held = null;
  entered = null;
  await page.getByText("Jev 标注完成", { exact: false }).waitFor();
  await page.getByText("易用性", { exact: true }).first().waitFor();
  workspace = (await json(`/review-workspaces/${workspace.id}`)).workspace;
  assert.equal(workspace.annotatedCount, 2);
  assert.equal(workspace.data.runs[0].engine, "jev");
  assert.equal(workspace.data.runs[0].conversationId, null);
  assert.equal(workspace.data.rows[0].annotation.note, "");
  assert.equal((await json("/conversations")).conversations.length, 0);
  const usage = await json("/decisions/status");
  assert.equal(usage.requests, 1);
  assert.equal(usage.spentUsd, 0.000042);
  assert.equal(usage.reservedUsd, 0);
  assert.equal(JSON.stringify(usage).includes("synthetic-openrouter-only"), false);
  pass(
    "one explicit quick action calls the typed provider once, persists results/provenance and creates no fake chat",
  );
  await page.screenshot({ path: path.join(evidence, "jev-reviews.png"), animations: "disabled" });
  await page.getByRole("button", { name: "查看与修正 r2", exact: true }).click();
  const annotationDialog = page.getByRole("dialog");
  assert.equal(await annotationDialog.getByLabel("主题", { exact: true }).inputValue(), "易用性");
  await annotationDialog.getByLabel("标注说明", { exact: true }).fill("Easy to use");
  await annotationDialog.getByRole("button", { name: "保存人工修正", exact: true }).click();
  await annotationDialog.waitFor({ state: "hidden" });
  const noted = (await json(`/review-workspaces/${workspace.id}`)).workspace;
  assert.deepEqual(noted.data.rows[0].annotation.topics, ["jev:usability"]);
  const noteRequestId = crypto.randomUUID();
  const noteCheck = await json(`/review-workspaces/${workspace.id}/rows/r2/verify-note`, "POST", {
    expectedRevision: noted.revision,
    requestId: noteRequestId,
  });
  assert.equal(noteCheck.verification.model, "typesafe/jev-1.14-20261014");
  assert.equal(noteCheck.request.model, "typesafe/jev-1.14");
  const cachedNote = await json(`/review-workspaces/${workspace.id}/rows/r2/verify-note`, "POST", {
    expectedRevision: noted.revision,
    requestId: noteRequestId,
  });
  assert.equal(cachedNote.cached, true);
  assert.deepEqual(cachedNote.request, noteCheck.request);
  assert.equal((await json("/__fixture/decision-stats")).calls, 2);
  pass(
    "existing note verification uses OpenRouter, preserves request provenance and reuses saved checks without re-billing",
  );

  const other = await create("Budget synthetic project", "Different comment");
  const annotated = (
    await json(`/review-workspaces/${other.id}/rows/r2`, "PATCH", {
      expectedRevision: other.revision,
      annotation: {
        sentiment: "negative",
        topics: ["manual"],
        quote: "Different",
        note: "Original note",
      },
    })
  ).workspace;
  await json("/__fixture/decision-budget", "POST", { limit: 0 });
  await page.getByRole("button", { name: "刷新已保存数据", exact: true }).first().click();
  await page.getByRole("combobox", { name: "选择评论项目", exact: true }).selectOption(other.id);
  await page.getByRole("heading", { name: other.title, exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "选择评论 r2", exact: true }).check();
  await page.getByRole("button", { name: "Jev 快速标注", exact: true }).click();
  await page.getByText("今日 Jev 可用额度不足；原标注已保留。", { exact: true }).waitFor();
  const afterBudget = (await json(`/review-workspaces/${other.id}`)).workspace;
  assert.deepEqual(afterBudget.data.rows[0].annotation, annotated.data.rows[0].annotation);
  assert.equal(afterBudget.data.runs.at(-1).decision.status, "failed");
  assert.equal((await json("/__fixture/decision-stats")).calls, 2);
  pass(
    "exhausted budget preserves manual annotations and records a failed batch without contacting the model",
  );
  await json("/__fixture/decision-budget", "POST", { limit: 0.05 });
  const last = await create("Navigation synthetic project", "A final distinct comment");
  await page.getByRole("button", { name: "刷新已保存数据", exact: true }).first().click();
  await page.getByRole("combobox", { name: "选择评论项目", exact: true }).selectOption(last.id);
  await page.getByRole("heading", { name: last.title, exact: true }).waitFor();
  await page.getByRole("button", { name: "选择下一批未标注", exact: true }).click();
  const lateStarted = new Promise((done) => {
    entered = done;
  });
  held = new Promise((done) => {
    release = done;
  });
  await page.getByRole("button", { name: "Jev 快速标注", exact: true }).click();
  await lateStarted;
  await page.getByRole("button", { name: "Settings fixture", exact: true }).click();
  const lateResponse = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/jev-runs"));
  release();
  held = null;
  entered = null;
  await lateResponse;
  assert.equal(await page.getByText("Jev 决策辅助", { exact: true }).isVisible(), true);
  assert.equal((await json(`/review-workspaces/${last.id}`)).workspace.annotatedCount, 1);
  pass(
    "late classification persists independently without navigating back into a closed review page",
  );

  assert.equal((await json("/__fixture/route-shadow", "POST")).route, "local");
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await json("/decisions/status")).shadow.compared) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const shadow = (await json("/decisions/status")).shadow;
  assert.equal(shadow.compared, 1);
  assert.equal(shadow.disagreements, 1);
  await page.getByRole("button", { name: "刷新用量", exact: true }).click();
  await page.getByText("已对照 1 次 · 路由差异 1 次", { exact: true }).waitFor();
  pass("shadow routing records a disagreement while the actual route remains unchanged");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    `${JSON.stringify({ checks, errors, unexpected, requests }, null, 2)}\n`,
  );
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser?.close();
  await server?.close();
  child.kill("SIGTERM");
}
