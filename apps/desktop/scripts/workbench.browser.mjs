import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir =
  process.env.OPENHORN_WORKBENCH_EVIDENCE || path.join(os.tmpdir(), "openhorn-workbench-evidence");
await mkdir(evidenceDir, { recursive: true });
process.chdir(desktop);
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: {
    port: 23000 + Math.floor(Math.random() * 10000),
    strictPort: true,
    host: "127.0.0.1",
    watch: null,
    hmr: false,
  },
});
let browser;
const requests = [];
const errors = [];
const unexpected = [];
const recipes = [];
const recipeHistory = new Map();
let failHistory = false;
const artifacts = [];
const versions = new Map();
const tasks = [];
const scheduledRuns = [];
let failTaskList = false;
let failRunList = false;
let failDelete = false;
let failToggle = false;
let holdToggle = null;
let toggleEntered;
let holdManualRun = null;
let manualRunEntered;
const now = "2026-11-06T00:00:00Z";
const sourceConversation = {
  id: "source-conversation",
  title: "Synthetic source",
  channelId: "fixture-channel",
  modelId: "fixture-model",
  contextLength: 8192,
  defaultMode: "agent",
  lastMode: "agent",
  forceWebSearch: false,
  isPinned: false,
  createdAt: now,
  updatedAt: now,
};
const conversations = [sourceConversation];
let original = "";
let forceConflict = false;
let holdPrepare = null;
let prepareEntered;
let heldContinue = null;
let continueEntered;
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.fixtureIpc = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (command, args) => {
        window.fixtureIpc.push({ command, args });
        if (command === "skills_discover" || command === "skills_disabled_list") return [];
        if (command === "save_attachment") return null;
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return null;
        throw new Error(`Unexpected IPC ${command}`);
      },
    };
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== "http://127.0.0.1:3002") {
      unexpected.push(url.href);
      return route.abort();
    }
    const method = route.request().method();
    const data = route.request().postDataJSON() ?? {};
    const endpoint = url.pathname;
    requests.push({ method, path: endpoint, data });
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "OPTIONS") return json({});
    if (endpoint === "/recipes" && method === "GET") return json({ recipes });
    if (endpoint === "/recipes" && method === "POST") {
      const recipe = {
        id: `recipe-${recipes.length + 1}`,
        version: 1,
        spec: data.spec,
        createdAt: now,
        updatedAt: now,
      };
      recipes.push(recipe);
      recipeHistory.set(recipe.id, [
        { recipeId: recipe.id, version: 1, spec: structuredClone(recipe.spec), createdAt: now },
      ]);
      return json({ recipe }, 201);
    }
    const recipeMatch = endpoint.match(/^\/recipes\/([^/]+)(?:\/(prepare|schedule))?$/);
    if (recipeMatch) {
      const recipe = recipes.find((r) => r.id === recipeMatch[1]);
      if (!recipe) return json({ errorCode: "recipe_not_found" }, 404);
      if (method === "PUT") {
        if (data.expectedVersion !== recipe.version)
          return json({ errorCode: "recipe_version_conflict" }, 409);
        recipe.spec = data.spec;
        recipe.version++;
        recipeHistory.get(recipe.id).push({
          recipeId: recipe.id,
          version: recipe.version,
          spec: structuredClone(recipe.spec),
          createdAt: now,
        });
        return json({ recipe });
      }
      if (recipeMatch[2] === "schedule") {
        await new Promise((resolve) => setTimeout(resolve, 120));
        const task = {
          id: `task-${tasks.length + 1}`,
          userId: "fixture-user",
          title: data.title ?? recipe.spec.title,
          prompt: recipe.spec.promptTemplate,
          recipeSnapshot: {
            recipeId: recipe.id,
            version: data.version,
            spec: recipe.spec,
            values: data.values,
            renderedPrompt: recipe.spec.promptTemplate,
          },
          projectId: recipe.spec.projectId ?? null,
          frequency: data.frequency,
          time: data.time,
          enabled: true,
          notifyOnComplete: data.notifyOnComplete ?? true,
          channelId: null,
          modelId: null,
          createdAt: now,
          updatedAt: now,
          lastRunAt: null,
          nextRunAt: now,
        };
        tasks.push(task);
        return json({ task }, 201);
      }
      if (recipeMatch[2] === "prepare") {
        prepareEntered?.();
        if (holdPrepare) await holdPrepare;
        const conversationId = `prepared-${conversations.length}`;
        conversations.push({
          ...sourceConversation,
          id: conversationId,
          title: recipe.spec.title,
          projectId: recipe.spec.projectId ?? null,
        });
        const prompt = recipe.spec.promptTemplate.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
          String(data.values[key] ?? ""),
        );
        return json({
          conversationId,
          prompt,
          requirements: recipe.spec.requirements,
          recipeId: recipe.id,
          recipeVersion: recipe.version,
        });
      }
      if (failHistory) return json({ errorCode: "unknown" }, 503);
      return json({ recipe, versions: [...recipeHistory.get(recipe.id)].reverse() });
    }
    if (endpoint === "/artifacts" && method === "GET") return json({ artifacts });
    if (endpoint === "/artifacts" && method === "POST") {
      const artifact = {
        id: `artifact-${artifacts.length + 1}`,
        title: data.title || "Synthetic artifact",
        projectId: null,
        currentVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      const version = {
        artifactId: artifact.id,
        version: 1,
        content: original,
        format: "markdown",
        sourceConversationId: sourceConversation.id,
        sourceMessageId: "source-message",
        createdAt: now,
      };
      artifacts.push(artifact);
      versions.set(artifact.id, [version]);
      return json({ artifact, version }, 201);
    }
    const artifactMatch = endpoint.match(/^\/artifacts\/([^/]+)(?:\/(versions))?$/);
    if (artifactMatch) {
      const artifact = artifacts.find((a) => a.id === artifactMatch[1]);
      if (!artifact) return json({ errorCode: "artifact_not_found" }, 404);
      const history = versions.get(artifact.id);
      if (method === "POST") {
        if (forceConflict || data.expectedVersion !== artifact.currentVersion)
          return json({ errorCode: "artifact_version_conflict" }, 409);
        const version = {
          ...history.at(-1),
          version: ++artifact.currentVersion,
          content: data.content ?? original,
          format: data.format ?? "markdown",
        };
        history.push(version);
        return json({ artifact, version }, 201);
      }
      if (method === "PATCH") {
        artifact.title = data.title;
        return json({ artifact });
      }
      const version =
        history.find((v) => v.version === Number(url.searchParams.get("version"))) ??
        history.at(-1);
      return json({ artifact, version, versions: history.map(({ content, ...meta }) => meta) });
    }
    if (endpoint === "/conversations" && method === "POST") {
      continueEntered?.();
      if (heldContinue) await heldContinue;
      const conversation = {
        ...sourceConversation,
        ...data,
        id: `continue-${conversations.length}`,
      };
      conversations.push(conversation);
      return json({ conversation }, 201);
    }
    if (endpoint === "/conversations") return json({ conversations });
    if (endpoint.startsWith("/messages/") && method === "GET") return json({ messages: [] });
    if (endpoint === "/messages/sync-sidecar")
      return json({
        userMessageId: data.userMessageId,
        assistantMessageId: data.assistantMessageId ?? data.newAssistantMessageId,
      });
    if (endpoint === "/channels") return json({ channels: [] });
    if (endpoint === "/channels/fixture-channel/credentials")
      return json({
        credentials: {
          apiKey: "fixture-only",
          protocol: "openai",
          modelId: "fixture-model",
          baseUrl: null,
        },
      });
    if (endpoint === "/settings/search-status") return json({ configured: false, source: "none" });
    if (endpoint === "/settings") return json({ settings: { "prompts.templates": "[]" } });
    if (endpoint === "/mcp/servers") return json({ servers: [] });
    if (endpoint.match(/^\/scheduled-tasks\/[^/]+\/toggle$/) && method === "PATCH") {
      toggleEntered?.();
      if (holdToggle) await holdToggle;
      if (failToggle) return json({ error: "Synthetic toggle failure" }, 500);
      const task = tasks.find((item) => item.id === endpoint.split("/")[2]);
      task.enabled = !task.enabled;
      return json({ task });
    }
    if (endpoint.match(/^\/scheduled-tasks\/[^/]+\/run$/) && method === "POST") {
      manualRunEntered?.();
      if (holdManualRun) await holdManualRun;
      const taskId = endpoint.split("/")[2];
      scheduledRuns.push({ id: "manual-queued", taskId, status: "pending", startedAt: now });
      return json({ conversationId: sourceConversation.id }, 201);
    }
    if (endpoint.startsWith("/scheduled-tasks/") && method === "DELETE") {
      if (failDelete) return json({ error: "Synthetic delete failure" }, 500);
      const runMatch = endpoint.match(/^\/scheduled-tasks\/runs\/([^/]+)$/);
      if (runMatch) {
        const index = scheduledRuns.findIndex((item) => item.id === runMatch[1]);
        if (index >= 0) scheduledRuns.splice(index, 1);
      } else {
        const id = endpoint.split("/")[2];
        const index = tasks.findIndex((item) => item.id === id);
        if (index >= 0) tasks.splice(index, 1);
        for (let i = scheduledRuns.length - 1; i >= 0; i--)
          if (scheduledRuns[i].taskId === id) scheduledRuns.splice(i, 1);
      }
      return json({ success: true });
    }
    if (endpoint.startsWith("/scheduled-tasks/") && method === "PUT") {
      const task = tasks.find((item) => item.id === endpoint.split("/")[2]);
      if (!task) return json({ error: "not found" }, 404);
      Object.assign(task, data);
      return json({ task });
    }
    if (endpoint === "/scheduled-tasks") return failTaskList ? json({}, 500) : json({ tasks });
    if (endpoint === "/scheduled-tasks/runs" || /^\/scheduled-tasks\/[^/]+\/runs$/.test(endpoint))
      return failRunList ? json({}, 500) : json({ runs: scheduledRuns });
    unexpected.push(`${method} ${endpoint}`);
    return json({ error: "Unexpected fixture request" }, 500);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const recipeAction = async (name) => {
    await page.getByRole("button", { name: "更多配方操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  const artifactAction = async (name) => {
    await page.getByRole("button", { name: "更多成果操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  const selectArtifactVersion = async (version) => {
    if ((await page.getByLabel("版本", { exact: true }).count()) === 0)
      await artifactAction("版本历史");
    await page.getByLabel("版本", { exact: true }).selectOption(version);
    await page
      .locator("header span")
      .filter({ hasText: new RegExp(`^版本 ${version}$`) })
      .waitFor();
  };

  const capture = async (fileName) => {
    const controls = page.getByTestId("fixture-controls");
    await controls.evaluate((element) => {
      element.style.display = "none";
    });
    await page.screenshot({ path: path.join(evidenceDir, fileName), fullPage: true });
    await controls.evaluate((element) => {
      element.style.removeProperty("display");
    });
  };
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("PAGE ERROR", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error("CONSOLE", message.text());
  });
  page.on("requestfailed", (request) =>
    console.error("REQUEST FAILED", request.url(), request.failure()?.errorText),
  );
  await page.goto(`${origin}/tests/workbench.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  original = await page.evaluate(() => window.workbenchTest.source().content);
  await page.getByRole("button", { name: "竞品周报", exact: false }).click();
  const dialog = page.getByRole("dialog");
  const history = page.getByTestId("recipe-history");
  await dialog.getByLabel("配方名称", { exact: true }).fill("Weekly research");
  await dialog.getByRole("button", { name: "保存配方", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "编辑配方", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "查看历史版本", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "到定时任务设置…", exact: true }).count(), 0);
  pass("recipe defaults expose the run action while editing, history and scheduling stay in More");
  await page.getByLabel("公司或产品", { exact: false }).fill("Example A / B");
  const previewRequests = requests.length;
  const taskDetails = page.getByTestId("recipe-task-details");
  assert.equal(await taskDetails.getAttribute("open"), null);
  await taskDetails.locator("summary").click();
  await page.getByTestId("recipe-prompt-preview").waitFor();
  await taskDetails.locator("summary").click();
  assert.equal(await page.getByTestId("recipe-prompt-preview").isVisible(), false);
  await taskDetails.locator("summary").click();
  assert.ok(
    (await page.getByTestId("recipe-prompt-preview").innerText()).includes("Example A / B"),
  );
  await page.getByLabel("公司或产品", { exact: false }).fill("Preview update");
  assert.ok(
    (await page.getByTestId("recipe-prompt-preview").innerText()).includes("Preview update"),
  );
  assert.equal(requests.length, previewRequests);
  await page.getByLabel("搜索配方", { exact: true }).fill("no such recipe");
  await page.getByText("没有匹配的配方", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.getByLabel("公司或产品", { exact: false }).fill("Example A / B");
  pass("recipe preview tracks parameters without requests and empty search has a clear recovery");
  await page.getByRole("button", { name: "已保存成果", exact: true }).click();
  await page.getByRole("button", { name: "任务配方", exact: true }).click();
  assert.equal(await page.getByLabel("公司或产品", { exact: false }).inputValue(), "Example A / B");
  await page.getByRole("button", { name: "Source fixture", exact: true }).click();
  await page.getByRole("button", { name: "Workbench fixture", exact: true }).click();
  assert.equal(await page.getByLabel("公司或产品", { exact: false }).inputValue(), "Example A / B");
  pass("recipe parameters survive workbench tab and view navigation in the same session");
  failHistory = true;
  await recipeAction("查看历史版本");
  await history.getByRole("alert").waitFor();
  failHistory = false;
  await history.getByRole("button", { name: "重试", exact: true }).click();
  await history.getByLabel("配方历史版本", { exact: true }).waitFor();
  assert.equal(await history.getByLabel("配方历史版本", { exact: true }).inputValue(), "1");
  assert.ok(
    (await history.getByTestId("recipe-history-prompt").textContent()).includes("{{companies}}"),
  );
  assert.equal(await history.getByRole("button", { name: "运行一次", exact: true }).count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.getByRole("button", { name: "运行一次", exact: true }).count(), 0);
  await history.getByRole("button", { name: "收起历史", exact: true }).click();
  assert.equal(await page.getByLabel("公司或产品", { exact: false }).inputValue(), "Example A / B");
  pass("recipe history is read-only and a failed load can retry without losing current input");
  await recipeAction("编辑配方");
  await dialog.getByLabel("配方名称", { exact: true }).fill("Unsaved title");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  const discardNotice = page.getByRole("alert", { name: "放弃未保存的修改？", exact: true });
  await discardNotice.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await discardNotice.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await dialog.getByLabel("配方名称", { exact: true }).inputValue(), "Unsaved title");
  await page.keyboard.press("Escape");
  await discardNotice.getByRole("button", { name: "放弃修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(recipes[0].spec.title, "Weekly research");
  await recipeAction("编辑配方");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  pass("changed recipe dismissals require explicit discard while untouched forms close normally");
  await page.getByLabel("公司或产品", { exact: false }).fill("");
  const beforeInvalid = requests.length;
  await recipeAction("到定时任务设置…");
  await page.getByText("运行参数不完整或格式有误，请检查后重试。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重试", exact: true }).count(), 0);
  assert.equal(requests.length, beforeInvalid);
  await page.getByLabel("公司或产品", { exact: false }).fill("Example A / B");
  assert.equal(await page.getByRole("alert").count(), 0);
  pass("parameter validation stays local, clears when edited and never suggests reloading");
  await capture("recipes.png");
  await page.getByRole("button", { name: "运行一次", exact: true }).click();
  await page.getByTestId("handoff").waitFor();
  const handoff = await page.evaluate(() => window.workbenchTest.pending());
  assert.equal(handoff.conversationId, "prepared-1");
  assert.ok(handoff.text.includes("Example A / B"));
  pass("template save, parameter form and target-bound immediate run");

  await page.getByRole("button", { name: "Workbench fixture" }).click();
  assert.equal(await page.getByLabel("执行时间", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "竞品周报", exact: false }).count(), 0);
  await page.getByLabel("公司或产品", { exact: false }).fill("Cancelled schedule");
  await recipeAction("到定时任务设置…");
  await page.locator("h1").filter({ hasText: "定时任务" }).waitFor();
  await dialog.getByTestId("scheduled-recipe-source").waitFor();
  assert.ok(
    (await dialog.getByTestId("scheduled-recipe-source").innerText()).includes("Weekly research"),
  );
  assert.equal(tasks.length, 0);
  assert.equal(await dialog.locator("#scheduled-task-prompt").isEditable(), false);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(tasks.length, 0);
  pass("recipe scheduling hands off to existing task dialog and cancel creates nothing");
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await page.evaluate(() => window.workbenchTest.openTasks());
  await page.locator("h1").filter({ hasText: "定时任务" }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  failTaskList = true;
  failRunList = true;
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await page.evaluate(() => window.workbenchTest.openTasks());
  await page.getByText("无法加载定时任务，已有任务未被删除。", { exact: true }).waitFor();
  assert.equal(await page.getByText("还没有创建定时任务", { exact: true }).count(), 0);
  failTaskList = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByText("还没有创建定时任务", { exact: true }).waitFor();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.getByText("无法加载执行记录，请重试。", { exact: true }).waitFor();
  assert.equal(await page.getByText("暂无执行记录", { exact: true }).count(), 0);
  failRunList = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.getByText("暂无执行记录", { exact: true }).waitFor();
  pass("failed task and run loads show retry instead of false empty states");

  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await page.getByLabel("公司或产品", { exact: false }).fill("Scheduled A");
  await recipeAction("到定时任务设置…");
  await dialog.getByTestId("scheduled-recipe-source").waitFor();
  await dialog.locator("#scheduled-task-name").fill("Scheduled research");
  await dialog.locator("#scheduled-task-time").fill("10:15");
  await dialog.getByRole("checkbox").uncheck();
  await capture("recipe-schedule.png");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/recipes/recipe-1/schedule") &&
        response.request().method() === "POST",
    ),
    dialog.getByRole("button", { name: "保存任务", exact: true }).dblclick({ delay: 10 }),
  ]);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Scheduled research");
  assert.equal(tasks[0].notifyOnComplete, false);
  assert.equal(tasks[0].time, "10:15");
  await page.getByTestId("scheduled-task-recipe-source").waitFor();
  await page.getByText("已启用", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "任务操作：Scheduled research", exact: true })
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  await capture("scheduled-tasks.png");
  await page.getByRole("button", { name: "任务操作：Scheduled research", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  assert.equal(await dialog.locator("#scheduled-task-prompt").isEditable(), false);
  assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
  await dialog.locator("#scheduled-task-time").fill("11:20");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/scheduled-tasks/task-1") && response.request().method() === "PUT",
    ),
    dialog.getByRole("button", { name: "保存修改", exact: true }).click(),
  ]);
  await dialog.waitFor({ state: "hidden" });
  const frozenEdit = requests.find(
    (r) => r.method === "PUT" && r.path === "/scheduled-tasks/task-1",
  );
  assert.equal(Object.hasOwn(frozenEdit.data, "prompt"), false);
  assert.equal(tasks[0].notifyOnComplete, false);
  tasks.push({
    ...tasks[0],
    id: "manual-task",
    title: "Manual task",
    prompt: "Original manual prompt",
    enabled: false,
    recipeSnapshot: null,
  });
  await page.evaluate(() => window.workbenchTest.reloadTasks());
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: "任务操作：Manual task", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  assert.equal(await dialog.locator("#scheduled-task-prompt").isEditable(), true);
  await dialog.locator("#scheduled-task-prompt").fill("Updated manual prompt");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(tasks[1].prompt, "Updated manual prompt");
  pass("recipe task edits preserve frozen content while ordinary tasks remain editable");
  await page.getByRole("button", { name: "任务操作：Manual task", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await dialog.locator("#scheduled-task-prompt").fill("Unsaved schedule edit");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await discardNotice.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
  await discardNotice.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(
    await dialog.locator("#scheduled-task-prompt").inputValue(),
    "Unsaved schedule edit",
  );
  await page.keyboard.press("Escape");
  await discardNotice.getByRole("button", { name: "放弃修改", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(tasks[1].prompt, "Updated manual prompt");
  pass("schedule dismissal protects modified fields and discarding writes nothing");
  let releaseToggle;
  holdToggle = new Promise((done) => {
    releaseToggle = done;
  });
  const toggling = new Promise((done) => {
    toggleEntered = done;
  });
  failToggle = true;
  const manualSwitch = page.getByRole("switch", { name: "Manual task", exact: true });
  await manualSwitch.click();
  await toggling;
  assert.equal(await manualSwitch.isDisabled(), true);
  releaseToggle();
  holdToggle = null;
  toggleEntered = null;
  await page.getByText("启停设置未更新，已保留原状态，请重试。", { exact: true }).waitFor();
  assert.equal(await manualSwitch.isChecked(), false);
  assert.equal(requests.filter((r) => r.path === "/scheduled-tasks/manual-task/toggle").length, 1);
  failToggle = false;
  await manualSwitch.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('button[role="switch"][aria-label="Manual task"]')
        ?.getAttribute("aria-checked") === "true",
  );
  pass("pending toggle controls block duplicates and failure preserves the original state");
  const disposable = { ...tasks[1], id: "disposable-task", title: "Disposable task" };
  tasks.push(disposable);
  scheduledRuns.push({
    id: "disposable-run",
    taskId: disposable.id,
    taskTitle: disposable.title,
    status: "completed",
    startedAt: now,
  });
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await page.evaluate(() => window.workbenchTest.openTasks());
  await page.getByRole("button", { name: "任务操作：Disposable task", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除定时任务？", exact: true });
  const deletesBefore = requests.filter((r) => r.method === "DELETE").length;
  await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(requests.filter((r) => r.method === "DELETE").length, deletesBefore);
  await page.getByRole("button", { name: "任务操作：Disposable task", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  failDelete = true;
  await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteDialog
    .getByText("删除未成功，原内容已保留。请重试或取消。", { exact: true })
    .waitFor();
  assert.equal(
    tasks.some((task) => task.id === disposable.id),
    true,
  );
  await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.getByRole("button", { name: "删除执行记录：Disposable task", exact: true }).click();
  const runDeleteDialog = page.getByRole("dialog", { name: "删除执行记录？", exact: true });
  await runDeleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await runDeleteDialog
    .getByText("删除未成功，原内容已保留。请重试或取消。", { exact: true })
    .waitFor();
  assert.equal(scheduledRuns.length, 1);
  failDelete = false;
  await runDeleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await runDeleteDialog.waitFor({ state: "hidden" });
  assert.equal(scheduledRuns.length, 0);
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("button", { name: "任务操作：Disposable task", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await deleteDialog.waitFor({ state: "hidden" });
  assert.equal(
    tasks.some((task) => task.id === disposable.id),
    false,
  );
  pass("task and record deletion require confirmation and failed deletes retain their content");
  let releaseManualRun;
  holdManualRun = new Promise((done) => {
    releaseManualRun = done;
  });
  const manualRunStarted = new Promise((done) => {
    manualRunEntered = done;
  });
  await page.getByRole("button", { name: "任务操作：Manual task", exact: true }).click();
  await page.getByRole("menuitem", { name: "立即执行", exact: true }).click();
  await manualRunStarted;
  assert.equal(await manualSwitch.isDisabled(), true);
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  releaseManualRun();
  holdManualRun = null;
  manualRunEntered = null;
  await page.getByText("已加入执行队列", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.path === "/scheduled-tasks/manual-task/run").length, 1);
  pass("late manual-run acceptance reports queued without stealing the newer page");

  pass(
    "the shared task form owns time and notification settings and displays frozen recipe provenance",
  );
  await page.getByRole("button", { name: "Workbench fixture" }).click();

  recipes[0].spec.projectId = "removed-project";
  recipes[0].spec.channelId = "removed-channel";
  recipes[0].spec.modelId = "retired-model";
  await page.getByRole("button", { name: "Source fixture" }).click();
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await recipeAction("编辑配方");
  await dialog.getByText("运行设置（可选）", { exact: true }).click();
  assert.equal(await dialog.locator("#recipe-project").inputValue(), "removed-project");
  assert.equal(await dialog.locator("#recipe-channel").inputValue(), "removed-channel");
  await dialog.locator("#recipe-project").selectOption("");
  await dialog.locator("#recipe-channel").selectOption("");
  await dialog.getByRole("button", { name: "保存配方", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(recipes[0].spec.projectId, undefined);
  assert.equal(recipes[0].spec.channelId, undefined);
  assert.equal(recipes[0].spec.modelId, undefined);
  pass("unavailable recipe bindings stay visible and can be explicitly reset");

  await recipeAction("编辑配方");
  await dialog.getByText("运行设置（可选）", { exact: true }).click();
  await dialog
    .getByLabel("MCP（用逗号分隔名称）", { exact: true })
    .fill("missing-one, missing-two");
  await dialog.getByRole("button", { name: "保存配方", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByLabel("公司或产品", { exact: false }).fill("No tool");
  const preparesBefore = requests.filter((r) => r.path.endsWith("/prepare")).length;
  await page.getByRole("button", { name: "运行一次", exact: true }).click();
  await page.getByText("缺少已启用的 MCP：missing-one", { exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.path.endsWith("/prepare")).length, preparesBefore);
  assert.deepEqual(recipes[0].spec.requirements.mcpServers, ["missing-one", "missing-two"]);
  pass("multiple capability requirements remain editable and missing tools block preparation");
  const beforeHistory = requests.length;
  await recipeAction("查看历史版本");
  await history.getByLabel("配方历史版本", { exact: true }).selectOption("1");
  assert.ok(
    (await history.getByTestId("recipe-history-prompt").textContent()).includes("{{companies}}"),
  );
  assert.ok((await history.getByRole("option").count()) > 1);
  await history.getByRole("button", { name: "收起历史", exact: true }).click();
  await history.waitFor({ state: "hidden" });
  assert.equal(
    requests.slice(beforeHistory).every((r) => r.method === "GET"),
    true,
  );
  pass("older recipe versions remain readable after edits and browsing history performs no writes");
  await recipeAction("编辑配方");
  await dialog.getByText("运行设置（可选）", { exact: true }).click();
  await dialog.getByLabel("MCP（用逗号分隔名称）", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "保存配方", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByLabel("公司或产品", { exact: false }).fill("Cancelled request");
  let release;
  holdPrepare = new Promise((done) => {
    release = done;
  });
  const entered = new Promise((done) => {
    prepareEntered = done;
  });
  await page.getByRole("button", { name: "运行一次", exact: true }).click();
  await entered;
  const beforeCancel = await page.evaluate(() => window.workbenchTest.pending());
  await page.evaluate(() => window.workbenchTest.navigate());
  release();
  holdPrepare = null;
  prepareEntered = null;
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => window.workbenchTest.pending()), beforeCancel);
  pass("late recipe preparation cannot hand off after navigation");

  await page.getByRole("button", { name: "Source fixture" }).click();
  await page.locator("main > section").hover();
  await page.getByRole("button", { name: "收藏为成果", exact: true }).click();
  await dialog.getByLabel("成果名称", { exact: true }).fill("Research artifact");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(artifacts.length, 1);
  assert.equal(versions.get(artifacts[0].id)[0].content, original);
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await page.getByRole("button", { name: "已保存成果", exact: true }).click();
  await page.getByRole("heading", { name: "Research artifact", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "编辑为新版本", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "导出原文", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("版本", { exact: true }).count(), 0);
  pass("artifact defaults keep secondary actions and version controls hidden until requested");

  const frame = page.frameLocator("iframe").first();
  await frame.getByRole("button", { name: "Inspect", exact: true }).click();
  await frame.getByRole("button", { name: "Changed", exact: true }).waitFor();
  pass("saved message retains complete text and uses the existing interactive sandbox");

  await artifactAction("编辑为新版本");
  const editor = page.getByRole("textbox", { name: "原文", exact: true });
  const updated = `${original}\n\nVersion two with 中文.`;
  await editor.fill(updated);
  await page.getByRole("button", { name: "任务配方", exact: true }).click();
  await page.getByRole("button", { name: "已保存成果", exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), updated);
  await page.getByRole("button", { name: "Source fixture" }).click();
  await page.getByRole("button", { name: "Workbench fixture" }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), updated);
  const other = { ...artifacts[0], id: "other-artifact", title: "Other artifact" };
  artifacts.push(other);
  versions.set(other.id, [{ ...versions.get(artifacts[0].id)[0], artifactId: other.id }]);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("button", { name: /Other artifact 当前版本/ }).click();
  await page.getByRole("heading", { name: "Other artifact", exact: true }).waitFor();
  await page.getByRole("button", { name: /Research artifact 未保存草稿/ }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), updated);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await discardNotice.waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await discardNotice.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await editor.inputValue(), updated);
  await page.getByLabel("筛选成果", { exact: true }).fill("no such artifact");
  await page.getByText("没有匹配的成果", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  assert.equal(await editor.inputValue(), updated);
  pass(
    "artifact drafts survive item, tab and view navigation; cancel and empty search are recoverable",
  );
  artifacts[0].currentVersion = 2;
  versions
    .get(artifacts[0].id)
    .push({ ...versions.get(artifacts[0].id)[0], version: 2, content: "A remote version" });
  forceConflict = true;
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.getByText(/已有更新的版本/).waitFor();
  assert.equal(await editor.inputValue(), updated);
  assert.equal(artifacts[0].currentVersion, 2);
  const detailGets = requests.filter(
    (r) => r.method === "GET" && r.path === "/artifacts/artifact-1",
  ).length;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("将追加为版本 3，已有版本保持不变。", { exact: true }).waitFor();
  assert.ok(
    requests.filter((r) => r.method === "GET" && r.path === "/artifacts/artifact-1").length >
      detailGets,
  );
  assert.equal(await editor.inputValue(), updated);
  forceConflict = false;
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await selectArtifactVersion("3");
  assert.equal(versions.get(artifacts[0].id).length, 3);
  await selectArtifactVersion("1");
  await page.getByText("正在查看历史版本 1，最新为版本 3。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看最新版本", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#artifact-version")?.value === "3");
  await selectArtifactVersion("1");
  await artifactAction("原文");
  assert.equal(await page.getByTestId("artifact-raw").textContent(), original);
  await artifactAction("导出原文");
  await page.waitForFunction(() => window.fixtureIpc.some((r) => r.command === "save_attachment"));
  const exported = await page.evaluate(
    () => window.fixtureIpc.find((r) => r.command === "save_attachment").args,
  );
  assert.equal(new TextDecoder().decode(new Uint8Array(exported.bytes)), original);
  pass(
    "version conflict preserves draft, immutable history loads and original export matches bytes",
  );
  await artifactAction("编辑为新版本");
  await editor.fill("A draft that will be discarded");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await discardNotice.getByRole("button", { name: "放弃修改", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(versions.get(artifacts[0].id).length, 3);
  await artifactAction("编辑为新版本");
  assert.equal(await editor.inputValue(), original);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  pass("historical versions are explicit and discarding a draft never changes saved history");
  await artifactAction("编辑为新版本");
  await editor.fill("An intentional revision of historical version one");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#artifact-version")?.value === "4");
  assert.equal(versions.get(artifacts[0].id).length, 4);
  assert.equal(versions.get(artifacts[0].id)[0].content, original);
  assert.equal(versions.get(artifacts[0].id)[2].content, updated);
  pass("editing a historical version appends the next version and preserves existing history");

  let continueRelease;
  heldContinue = new Promise((done) => {
    continueRelease = done;
  });
  const enteredContinue = new Promise((done) => {
    continueEntered = done;
  });
  await page.getByRole("button", { name: "在新会话继续修改", exact: true }).click();
  await enteredContinue;
  const beforeContinue = await page.evaluate(() => window.workbenchTest.pending());
  await page.getByRole("button", { name: "任务配方", exact: true }).click();
  continueRelease();
  heldContinue = null;
  continueEntered = null;
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.workbenchTest.pending()), beforeContinue);
  pass("late artifact continuation cannot send after changing workbench tabs");

  await page.setViewportSize({ width: 760, height: 900 });
  await page.evaluate(() => window.workbenchTest.dark());
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "已保存成果", exact: true }).click();
  await page.getByRole("heading", { name: "Research artifact", exact: true }).waitFor();
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  assert.ok(dimensions.scroll <= dimensions.width);
  await capture("workbench-dark-narrow.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.workbenchTest.dark());
  await page.waitForTimeout(200);
  await capture("workbench-light.png");
  pass("artifact workspace fits narrow/dark and desktop/light viewports");

  await page.getByRole("button", { name: "在新会话继续修改", exact: true }).click();
  await page.getByTestId("handoff").waitFor();
  const editDraft = await page.evaluate(() => window.workbenchTest.pending());
  assert.equal(editDraft.autoSend, false);
  assert.ok(editDraft.text.endsWith("我的修改要求："));
  const continued = requests
    .filter((r) => r.path === "/conversations" && r.method === "POST")
    .at(-1);
  assert.equal(continued.data.channelId, "fixture-channel");
  assert.equal(continued.data.modelId, "fixture-model");
  await page.evaluate((draft) => window.workbenchTest.mountDraft(draft), editDraft);
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("textarea")).some((field) => field.value === expected),
    editDraft.text,
  );
  assert.equal(await page.evaluate(() => window.workbenchTest.runs().length), 0);
  pass("artifact continuation opens a bound editable draft without invoking a model");
  await page.evaluate((id) => window.workbenchTest.showReply(id), editDraft.conversationId);
  await page.locator("main > section").hover();
  const countBeforeContinuationSave = artifacts.length;
  await page.getByRole("button", { name: "收藏为成果", exact: true }).click();
  await dialog.getByLabel("目标成果", { exact: true }).waitFor();
  await page.waitForFunction(
    (id) => document.querySelector("#artifact-save-target")?.value === id,
    artifacts[0].id,
  );
  assert.equal(await dialog.getByLabel("目标成果", { exact: true }).inputValue(), artifacts[0].id);
  await dialog.getByText("将追加为版本 5，已有版本保持不变。", { exact: true }).waitFor();
  assert.equal(artifacts[0].currentVersion, 4);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(artifacts.length, countBeforeContinuationSave);
  assert.equal(artifacts[0].currentVersion, 5);
  const append = requests.filter((r) => r.method === "POST" && r.path.endsWith("/versions")).at(-1);
  assert.equal(append.data.sourceMessageId, "continuation-reply");
  pass(
    "a continuation reply preselects its original artifact and appends only after explicit save",
  );

  const removed = artifacts.shift();
  await page.locator("main > section").hover();
  await page.getByRole("button", { name: "收藏为成果", exact: true }).click();
  await dialog
    .getByText("原成果已不存在，请另存为新成果或选择其他成果。", { exact: true })
    .waitFor();
  assert.equal(await dialog.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
  await dialog.getByRole("button", { name: "新建成果", exact: true }).click();
  await dialog.getByLabel("成果名称", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  artifacts.unshift(removed);
  await page.evaluate(() => window.workbenchTest.showReply("unrelated-conversation"));
  await page.locator("main > section").hover();
  await page.getByRole("button", { name: "收藏为成果", exact: true }).click();
  await dialog.getByLabel("成果名称", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("目标成果", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  pass(
    "deleted continuation targets require an explicit alternative and other conversations default to a new artifact",
  );

  await page.evaluate(() => window.workbenchTest.startRealChat("wrong-conversation"));
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.workbenchTest.runs().length), 0);
  await page.evaluate(() =>
    window.workbenchTest.startRealChat("source-conversation", "Missing tool handoff", {
      skills: ["vanished-skill"],
      mcpServers: [],
      workspace: false,
      webSearch: false,
    }),
  );
  await page
    .getByText(/任务配方所需能力当前不可用/)
    .first()
    .waitFor();
  assert.equal(await page.evaluate(() => window.workbenchTest.runs().length), 0);
  pass("actual Agent startup refuses recipe requirements missing from its freshly loaded roster");
  await page.evaluate(() =>
    window.workbenchTest.startRealChat("source-conversation", "Exactly this handoff"),
  );
  await page.waitForFunction(() => window.workbenchTest.runs().length === 1);
  assert.equal(
    (await page.evaluate(() => window.workbenchTest.runs()))[0].prompt.includes(
      "Exactly this handoff",
    ),
    true,
  );
  pass("real chat composer rejects a wrong target and dispatches a matching handoff once");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidenceDir, "results.json"),
    JSON.stringify(
      {
        checks,
        errors,
        unexpected,
        requests: requests.map((r) => ({ method: r.method, path: r.path })),
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${evidenceDir}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
