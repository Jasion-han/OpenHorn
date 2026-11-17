import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence =
  process.env.OPENHORN_SETTINGS_EVIDENCE || "/tmp/openhorn-settings-clarity-evidence";
await mkdir(evidence, { recursive: true });
process.chdir(root);
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 24000 + Math.floor(Math.random() * 9000),
    strictPort: true,
    watch: null,
    hmr: false,
  },
});
let browser;
const requests = [],
  errors = [],
  unexpected = [],
  checks = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let agentFailRead = true,
  agentFailWrite = false;
let agentKey = "synthetic-original",
  agentEnabled = true;
let agentReadGate = null,
  agentReadEntered = null;
let agentWriteGate = null,
  agentWriteEntered = null;
let agentWrites = 0;
let instruction = "Original instructions";
let failRead = true,
  failWrite = false,
  failSearch = false;
let delayedSearch = null,
  searchEntered;
let delayedEstimate = null,
  estimateEntered;
let delayedDti = null,
  dtiEntered;
let delayedDetect = null,
  detectEntered,
  delayedImport = null,
  importEntered;
let failImport = false;
let imported = false;
let historyListFails = false;
let historyRows = [],
  historyCursor = null,
  historyPage = null,
  historyPageEntered;
let historyRefresh = null,
  historyRefreshEntered,
  historyDeleteFails = false;
const mcpServers = [
  {
    id: "fixture-mcp",
    name: "Synthetic MCP",
    type: "stdio",
    config: { command: "synthetic-only" },
    isEnabled: true,
  },
];
const importedConversation = {
  id: "imported-conversation",
  title: "Imported conversation",
  contextLength: 4096,
  defaultMode: "agent",
  lastMode: "agent",
  isPinned: false,
  forceWebSearch: false,
  createdAt: "2026-11-09T00:00:00Z",
  updatedAt: "2026-11-09T00:00:00Z",
};
const dti = [{ id: "synthetic", messages: [{ content: "Synthetic 中文 data" }] }];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.fixtureIpc = [];
    window.exportMode = "cancel";
    window.editorDetectFails = false;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (command, args) => {
        window.fixtureIpc.push({ command, args });
        if (command === "external_editors_detect") {
          if (window.editorDetectFails) throw new Error("Synthetic editor detection failure");
          return [
            {
              id: "fixture-editor",
              name: "Fixture Editor",
              appPath: "/synthetic/Editor.app",
              supportsLine: true,
            },
          ];
        }
        if (["mcp_discover_configs", "skills_discover", "skills_disabled_list"].includes(command))
          return [];
        if (command === "save_attachment") {
          if (window.exportMode === "failure") throw new Error("Synthetic disk failure");
          return window.exportMode === "cancel" ? null : "/fixture/openhorn-export.json";
        }
        if (command === "pick_import_file") return "/fixture/synthetic-backup.json";
        if (command === "pick_workspace_dir") throw new Error("DTI must use the file save dialog");
        throw new Error(`Unexpected IPC ${command}`);
      },
    };
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (url.origin === origin) return route.continue();
    if (url.origin !== "http://127.0.0.1:3002") {
      unexpected.push(url.href);
      return route.abort();
    }
    const endpoint = url.pathname;
    requests.push({ method, path: endpoint });
    const json = (value, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (method === "OPTIONS") return json({});
    if (endpoint === "/decisions/status")
      return json({
        configured: false,
        enabled: false,
        features: {
          reviews: false,
          suggestions: false,
          rerank: false,
          skills: false,
          routeShadow: false,
        },
        model: "typesafe/jev-1.14",
        day: "2026-11-09",
        dailyLimitUsd: 0.05,
        spentUsd: 0,
        reservedUsd: 0,
        requests: 0,
      });
    if (endpoint === "/settings") {
      if (url.searchParams.get("keys")?.includes("liveSearch.")) {
        const snapshot = {
          "liveSearch.tavilyApiKey": agentKey,
          "liveSearch.tavilyEnabled": String(agentEnabled),
        };
        agentReadEntered?.();
        if (agentReadGate) await agentReadGate;
        return agentFailRead ? json({}, 500) : json({ settings: snapshot });
      }
      return failRead ? json({}, 500) : json({ settings: { "chat.systemPrompt": instruction } });
    }
    if (endpoint.startsWith("/settings/liveSearch.")) {
      agentWrites++;
      const value = request.postDataJSON().value;
      agentWriteEntered?.();
      if (agentWriteGate) await agentWriteGate;
      if (agentFailWrite) return json({}, 500);
      if (endpoint.endsWith("tavilyApiKey")) agentKey = value ?? "";
      else agentEnabled = value === "true";
      return json({ success: true });
    }
    if (endpoint === "/settings/chat.systemPrompt") {
      if (failWrite) return json({}, 500);
      instruction = request.postDataJSON().value ?? "";
      return json({ success: true });
    }
    if (endpoint === "/search") {
      const q = url.searchParams.get("q");
      if (q === "slow") {
        searchEntered?.();
        if (delayedSearch) await delayedSearch;
      }
      if (failSearch) return json({}, 500);
      return json({
        results: [
          {
            kind: "message",
            id: `message-${q}`,
            messageId: `message-${q}`,
            conversationId: "synthetic",
            title: `Result ${q}`,
            snippet: `Match ${q}`,
          },
        ],
      });
    }
    if (endpoint === "/scheduled-tasks") return json({ tasks: [] });
    if (endpoint === "/scheduled-tasks/runs") return json({ runs: [] });
    if (endpoint === "/data-transfer/export/estimate") {
      estimateEntered?.();
      if (delayedEstimate) await delayedEstimate;
      return json({ conversations: 1, messages: 1, attachments: 2, estimatedBytes: 8192 });
    }
    if (endpoint === "/data-transfer/export/dti") {
      dtiEntered?.();
      if (delayedDti) await delayedDti;
      return json(dti);
    }
    if (endpoint === "/import/local/scan") return json({ sources: [] });
    if (endpoint === "/import/records") {
      if (historyListFails) return json({ error: "Synthetic history failure" }, 500);
      if (url.searchParams.get("cursor") === "old-more") {
        historyPageEntered?.();
        if (historyPage) await historyPage;
        return json({
          records: [{ ...historyRows[0], id: "old-page" }],
          nextCursor: "stale-cursor",
        });
      }
      const snapshot = { records: [...historyRows], nextCursor: historyCursor };
      historyRefreshEntered?.();
      if (historyRefresh) await historyRefresh;
      return json(snapshot);
    }
    if (endpoint.startsWith("/import/records/") && method === "DELETE") {
      if (historyDeleteFails) return json({ error: "Synthetic delete failure" }, 500);
      historyRows = historyRows.filter((record) => record.id !== endpoint.split("/").at(-1));
      return json({ success: true });
    }
    if (endpoint === "/credentials/sources") return json({ sources: [] });
    if (endpoint === "/mcp/servers") return json({ servers: mcpServers });
    if (endpoint === "/mcp/servers/fixture-mcp" && method === "PUT") {
      Object.assign(mcpServers[0], request.postDataJSON());
      return json({ success: true });
    }
    if (endpoint === "/projects") return json({ projects: [] });
    if (endpoint === "/conversations")
      return json({ conversations: imported ? [importedConversation] : [] });
    if (endpoint === "/data-transfer/import/detect") {
      detectEntered?.();
      if (delayedDetect) await delayedDetect;
      return json({ format: "openhorn" });
    }
    if (endpoint === "/data-transfer/import") {
      importEntered?.();
      if (delayedImport) await delayedImport;
      if (failImport) return json({ error: "Synthetic import failure" }, 500);
      imported = true;
      return json({
        format: "openhorn",
        conversations: { imported: 1, skipped: 0 },
        messages: { imported: 1 },
        attachments: { imported: 0, missing: 1 },
        channels: { imported: 0, skipped: 0, needsKey: 0 },
        projects: { imported: 0, needsRebind: 0 },
        mcpServers: { imported: 0, needsConfirm: 0 },
        scheduledTasks: { imported: 0 },
        errors: ["Synthetic missing attachment"],
      });
    }
    if (endpoint === "/channels") return json({ channels: [] });
    unexpected.push(`${method} ${endpoint}`);
    return json({}, 500);
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/settings-clarity.html`, { waitUntil: "domcontentloaded" });
  await page.getByText("无法加载自定义指令，请重试；本地草稿会保留。", { exact: true }).waitFor();
  const prompt = page.getByRole("textbox", { name: "自定义指令", exact: true });
  assert.equal(await prompt.isDisabled(), true);
  assert.equal(
    await page.getByRole("textbox", { name: "用户名", exact: true }).isEditable(),
    false,
  );
  assert.equal(await page.getByRole("button", { name: "保存修改", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "资料库", exact: true }).isDisabled(), false);
  failRead = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#general-system-prompt")?.value === "Original instructions",
  );
  pass("account identity is read-only and failed instruction load cannot overwrite unknown data");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await prompt.fill("Unsaved instruction draft");
  instruction = "Remote reconnect value";
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(await prompt.inputValue(), "Unsaved instruction draft");
  await page.getByRole("button", { name: "Leave fixture", exact: true }).click();
  await page.getByRole("button", { name: "General fixture", exact: true }).click();
  assert.equal(await prompt.inputValue(), "Unsaved instruction draft");
  failWrite = true;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("保存失败，修改尚未生效。请重试保存。", { exact: true }).waitFor();
  assert.equal(await prompt.inputValue(), "Unsaved instruction draft");
  failWrite = false;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#general-system-prompt")?.readOnly === true,
  );
  assert.equal(instruction, "Unsaved instruction draft");
  pass("instruction draft survives reconnect and navigation; failed save remains retryable");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await prompt.fill("Discard only this draft");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "放弃未保存的修改？", exact: true });
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  assert.equal(await prompt.inputValue(), "Discard only this draft");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
  assert.equal(await prompt.inputValue(), instruction);
  pass("discarding custom instructions is explicit and preserves the saved value");
  await page.getByRole("button", { name: "统一搜索", exact: true }).click();
  const search = page.getByRole("textbox", { name: "统一搜索", exact: true });
  let releaseSearch;
  delayedSearch = new Promise((done) => {
    releaseSearch = done;
  });
  const slowStarted = new Promise((done) => {
    searchEntered = done;
  });
  await search.fill("slow");
  await slowStarted;
  await search.fill("new");
  await page.getByText("Result new", { exact: true }).waitFor();
  releaseSearch();
  delayedSearch = null;
  searchEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("Result slow", { exact: true }).count(), 0);
  delayedSearch = new Promise((done) => {
    releaseSearch = done;
  });
  const clearStarted = new Promise((done) => {
    searchEntered = done;
  });
  await search.fill("slow");
  await clearStarted;
  await search.fill("");
  releaseSearch();
  delayedSearch = null;
  searchEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("Result slow", { exact: true }).count(), 0);
  failSearch = true;
  await search.fill("retry");
  await page.getByText("搜索失败，请重试。", { exact: true }).waitFor();
  failSearch = false;
  await page.getByRole("button", { name: "重试搜索", exact: true }).click();
  await page.getByText("Result retry", { exact: true }).waitFor();
  await search.press("Escape");
  pass("search rejects out-of-order and cleared responses and has explicit failure recovery");
  await page.screenshot({ path: path.join(evidence, "general-settings.png"), fullPage: true });
  await page.getByRole("button", { name: "Data fixture", exact: true }).click();
  const exportButton = page.getByRole("button", { name: "导出通用格式", exact: true });
  const confirm = page.getByRole("dialog", { name: "确认导出", exact: true });
  await exportButton.click();
  await confirm.waitFor();
  assert.ok((await confirm.innerText()).includes("附件仅包含元信息"));
  await confirm.getByRole("button", { name: "开始导出", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  assert.equal(await page.getByText("导出完成", { exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() =>
      window.fixtureIpc.some((call) => call.command === "pick_workspace_dir"),
    ),
    false,
  );
  pass("DTI uses the native file dialog and cancel never reports success");
  await page.evaluate(() => {
    window.exportMode = "failure";
  });
  await exportButton.click();
  await confirm.waitFor();
  await confirm.getByRole("button", { name: "开始导出", exact: true }).click();
  await page.getByText("导出失败", { exact: true }).waitFor();
  assert.equal(await page.getByText("导出完成", { exact: true }).count(), 0);
  await page.evaluate(() => {
    window.exportMode = "saved";
  });
  await confirm.getByRole("button", { name: "开始导出", exact: true }).dblclick({ delay: 10 });
  await confirm.waitFor({ state: "hidden" });
  await page.getByText("文件已保存到 /fixture/openhorn-export.json", { exact: true }).waitFor();
  const receipt = await page.evaluate(() =>
    window.fixtureIpc.filter((call) => call.command === "save_attachment").at(-1),
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(new Uint8Array(receipt.args.bytes))), dti);
  assert.equal(
    await page.evaluate(
      () => window.fixtureIpc.filter((call) => call.command === "save_attachment").length,
    ),
    3,
  );
  pass(
    "DTI save failures remain retryable and success uses the actual file receipt with exact JSON bytes",
  );
  let releaseEstimate;
  delayedEstimate = new Promise((done) => {
    releaseEstimate = done;
  });
  const estimating = new Promise((done) => {
    estimateEntered = done;
  });
  await exportButton.click();
  await estimating;
  await page.getByRole("button", { name: "General fixture", exact: true }).click();
  releaseEstimate();
  delayedEstimate = null;
  estimateEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await confirm.count(), 0);
  pass("late export estimates cannot reopen a dialog after navigation");
  await page.getByRole("button", { name: "Data fixture", exact: true }).click();
  let releaseDti;
  delayedDti = new Promise((done) => {
    releaseDti = done;
  });
  const downloading = new Promise((done) => {
    dtiEntered = done;
  });
  await exportButton.click();
  await confirm.waitFor();
  const savesBeforeNavigation = await page.evaluate(
    () => window.fixtureIpc.filter((call) => call.command === "save_attachment").length,
  );
  await confirm.getByRole("button", { name: "开始导出", exact: true }).click();
  await downloading;
  // A real navigation is possible while the response is pending (e.g. sidebar).
  await page
    .getByRole("button", { name: "General fixture", exact: true, includeHidden: true })
    .evaluate((element) => element.click());
  releaseDti();
  delayedDti = null;
  dtiEntered = null;
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(
      () => window.fixtureIpc.filter((call) => call.command === "save_attachment").length,
    ),
    savesBeforeNavigation,
  );
  pass("late DTI data cannot open a native save dialog after leaving the export page");
  await page.getByRole("button", { name: "MCP fixture", exact: true }).click();
  await page.getByText("Synthetic MCP", { exact: true }).waitFor();
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.getByText("1 个工具", { exact: true }).waitFor();
  await page.getByTitle("修改", { exact: true }).click();
  const mcpDialog = page.getByRole("dialog", { name: "修改 MCP Server", exact: true });
  const mcpWrites = requests.filter(
    (request) => request.path.startsWith("/mcp/servers/") && request.method === "PUT",
  ).length;
  await mcpDialog.locator("textarea").fill("null");
  await mcpDialog.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByText("MCP 配置必须是 JSON 对象，不能是 null、数组或文本。", { exact: true })
    .waitFor();
  assert.equal(
    requests.filter(
      (request) => request.path.startsWith("/mcp/servers/") && request.method === "PUT",
    ).length,
    mcpWrites,
  );
  await mcpDialog.locator("textarea").fill(JSON.stringify({ url: "https://fixture.invalid/mcp" }));
  await mcpDialog.getByRole("button", { name: "保存", exact: true }).click();
  await mcpDialog.waitFor({ state: "hidden" });
  await page.getByText("http", { exact: true }).waitFor();
  assert.equal(await page.getByText("1 个工具", { exact: true }).count(), 0);
  assert.equal(mcpServers[0].type, "http");
  await page.evaluate(() => {
    window.probeFixture.hold = true;
  });
  await page.getByRole("button", { name: "测试", exact: true }).click();
  await page.waitForFunction(() => !!window.probeFixture.release);
  await page.getByTitle("修改", { exact: true }).click();
  await mcpDialog
    .locator("textarea")
    .fill(JSON.stringify({ url: "https://fixture.invalid/changed" }));
  await mcpDialog.getByRole("button", { name: "保存", exact: true }).click();
  await mcpDialog.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    window.probeFixture.release();
    window.probeFixture.hold = false;
  });
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("1 个工具", { exact: true }).count(), 0);
  pass("MCP edits validate object config, update transport and discard stale health probes");
  await page.getByRole("button", { name: "Data fixture", exact: true }).click();
  const chooseImport = page.getByRole("button", { name: "选择文件", exact: true });
  let releaseDetect;
  delayedDetect = new Promise((done) => {
    releaseDetect = done;
  });
  const detecting = new Promise((done) => {
    detectEntered = done;
  });
  await chooseImport.click();
  await detecting;
  await page.getByRole("button", { name: "General fixture", exact: true }).click();
  releaseDetect();
  delayedDetect = null;
  detectEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("dialog", { name: "确认导入", exact: true }).count(), 0);
  pass("late import format detection cannot open a dialog on a newer page");
  await page.getByRole("button", { name: "Data fixture", exact: true }).click();
  await chooseImport.click();
  const importDialog = page.getByRole("dialog", { name: "确认导入", exact: true });
  await importDialog.waitFor();
  assert.ok((await importDialog.innerText()).includes("/fixture/synthetic-backup.json"));
  const importsBefore = requests.filter(
    (request) => request.path === "/data-transfer/import",
  ).length;
  await importDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    requests.filter((request) => request.path === "/data-transfer/import").length,
    importsBefore,
  );
  await chooseImport.click();
  await importDialog.waitFor();
  failImport = true;
  await importDialog.getByRole("button", { name: "开始导入", exact: true }).click();
  await page.getByText("导入失败", { exact: true }).waitFor();
  assert.equal(await importDialog.isVisible(), true);
  failImport = false;
  await importDialog.getByRole("button", { name: "开始导入", exact: true }).dblclick({ delay: 10 });
  const partial = page.getByRole("dialog", { name: "导入完成，有项目需要处理", exact: true });
  await partial.waitFor();
  assert.equal(
    requests.filter((request) => request.path === "/data-transfer/import").length,
    importsBefore + 2,
  );
  await partial.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "Imported conversation", exact: true }).waitFor();
  pass(
    "import cancel writes nothing; retry submits once, reports partial results and refreshes sidebar data",
  );
  let releaseImport;
  delayedImport = new Promise((done) => {
    releaseImport = done;
  });
  const importing = new Promise((done) => {
    importEntered = done;
  });
  await chooseImport.click();
  await importDialog.waitFor();
  await importDialog.getByRole("button", { name: "开始导入", exact: true }).click();
  await importing;
  await page
    .getByRole("button", { name: "General fixture", exact: true, includeHidden: true })
    .evaluate((element) => element.click());
  releaseImport();
  delayedImport = null;
  importEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await partial.count(), 0);
  pass("an import already accepted can complete without a late result dialog stealing navigation");
  await page.evaluate(() => {
    window.editorDetectFails = true;
  });
  const rescan = page.getByRole("button", { name: "重新检测编辑器", exact: true });
  await rescan.click();
  await page
    .getByText("暂时无法检测编辑器，可重新检测；已有选择会保留。", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.editorDetectFails = false;
  });
  await rescan.click();
  await page.getByRole("combobox", { name: "打开文件的编辑器", exact: true }).click();
  await page.getByRole("option", { name: "Fixture Editor", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  pass("editor detection failure is explicit and a forced rescan recovers without restarting");
  const makeHistory = (id) => ({
    id,
    userId: "fixture-user",
    source: "file",
    kind: "backup",
    parts: [],
    errors: [],
    totalImported: 1,
    totalNeedsAction: 0,
    createdAt: "2026-11-09T00:00:00Z",
  });
  historyRows = [makeHistory("old-first")];
  historyCursor = "old-more";
  historyListFails = true;
  await page.getByRole("button", { name: "Data fixture", exact: true }).click();
  await page.getByText("暂时无法加载导入记录，请重试。已有记录会保留。", { exact: true }).waitFor();
  historyListFails = false;
  await page.getByRole("button", { name: "重新加载记录", exact: true }).click();
  await page.locator("#import-record-old-first").waitFor();
  pass("history loading errors stay visible and recover through an explicit retry");
  let releaseHistoryPage;
  historyPage = new Promise((done) => {
    releaseHistoryPage = done;
  });
  const pagingHistory = new Promise((done) => {
    historyPageEntered = done;
  });
  await page.getByRole("button", { name: "查看更多", exact: true }).click();
  await pagingHistory;
  historyRows = [makeHistory("fresh")];
  historyCursor = null;
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  await page.locator("#import-record-fresh").waitFor();
  releaseHistoryPage();
  historyPage = null;
  historyPageEntered = null;
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#import-record-old-page").count(), 0);
  assert.equal(await page.getByRole("button", { name: "查看更多", exact: true }).count(), 0);
  pass("a delayed history page cannot mix into a refreshed list or restore its old cursor");
  let releaseHistoryRefresh;
  historyRefresh = new Promise((done) => {
    releaseHistoryRefresh = done;
  });
  const refreshingHistory = new Promise((done) => {
    historyRefreshEntered = done;
  });
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  await refreshingHistory;
  const historyCard = page.locator("#import-record-fresh");
  await historyCard.getByTitle("删除记录", { exact: true }).click();
  const confirmHistory = page.getByRole("dialog", { name: "删除导入记录？", exact: true });
  const beforeHistoryDelete = requests.filter(
    (request) => request.method === "DELETE" && request.path.startsWith("/import/records/"),
  ).length;
  await confirmHistory.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    requests.filter(
      (request) => request.method === "DELETE" && request.path.startsWith("/import/records/"),
    ).length,
    beforeHistoryDelete,
  );
  await historyCard.getByTitle("删除记录", { exact: true }).click();
  historyDeleteFails = true;
  await confirmHistory.getByRole("button", { name: "删除记录", exact: true }).click();
  await page.getByText("删除失败", { exact: true }).waitFor();
  assert.equal(await historyCard.count(), 1);
  historyDeleteFails = false;
  await confirmHistory
    .getByRole("button", { name: "删除记录", exact: true })
    .dblclick({ delay: 10 });
  await confirmHistory.waitFor({ state: "hidden" });
  assert.equal(
    requests.filter(
      (request) => request.method === "DELETE" && request.path.startsWith("/import/records/"),
    ).length,
    beforeHistoryDelete + 2,
  );
  releaseHistoryRefresh();
  historyRefresh = null;
  historyRefreshEntered = null;
  await page.getByText("还没有导入记录。", { exact: true }).waitFor();
  assert.equal(await historyCard.count(), 0);
  pass(
    "history deletion confirms scope, preserves failed items and rejects resurrection by old reads",
  );
  await page.getByRole("button", { name: "Agent fixture", exact: true }).click();
  const agentInput = page.getByLabel("Tavily API Key", { exact: true });
  const agentSwitch = page.getByRole("switch", { name: "启用 Tavily 搜索", exact: true });
  const agentSave = page.getByRole("button", { name: "保存", exact: true });
  await page.getByText("无法加载 Agent 设置。", { exact: true }).waitFor();
  assert.equal(await agentInput.isDisabled(), true);
  assert.equal(await agentSwitch.isDisabled(), true);
  assert.equal(await agentSave.isDisabled(), true);
  assert.equal(await page.getByText("使用服务端默认", { exact: true }).count(), 0);
  pass("Agent initial read failure blocks edits and avoids pretending a default is loaded");
  agentFailRead = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#tavily-api-key")?.value === "synthetic-original",
  );
  await agentInput.fill("synthetic-draft");
  agentKey = "synthetic-remote";
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  await page.getByText("用户覆盖中", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#tavily-api-key")?.value === "synthetic-remote",
  );
  await agentInput.fill("synthetic-draft");
  let releaseRead;
  const readEntered = new Promise((done) => {
    agentReadEntered = done;
  });
  agentReadGate = new Promise((done) => {
    releaseRead = done;
  });
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  await readEntered;
  assert.equal(await agentInput.inputValue(), "synthetic-draft");
  pass("Agent reconnect preserves dirty key and cancel restores the refreshed baseline");
  let releaseWrite;
  const writeEntered = new Promise((done) => {
    agentWriteEntered = done;
  });
  agentWriteGate = new Promise((done) => {
    releaseWrite = done;
  });
  const beforeAgentWrites = agentWrites;
  await agentSave.click();
  await writeEntered;
  assert.equal(await agentInput.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "保存中...", exact: true }).isDisabled(),
    true,
  );
  assert.equal(agentWrites, beforeAgentWrites + 1);
  releaseRead();
  agentReadGate = null;
  agentReadEntered = null;
  await page.getByRole("button", { name: "Reconnect fixture", exact: true }).click();
  assert.equal(await agentInput.inputValue(), "synthetic-draft");
  releaseWrite();
  agentWriteGate = null;
  agentWriteEntered = null;
  await page.waitForFunction(() => !document.querySelector("#tavily-api-key")?.disabled);
  assert.equal(agentKey, "synthetic-draft");
  assert.equal(await agentInput.inputValue(), "synthetic-draft");
  assert.equal(await agentSave.isDisabled(), true);
  pass("Agent pending save disables duplicate writes and reconnect cannot overwrite saved input");

  agentFailWrite = true;
  await agentInput.fill("synthetic-retry");
  await agentSave.click();
  await page.getByText("无法保存 Tavily Key。", { exact: true }).waitFor();
  assert.equal(await agentInput.inputValue(), "synthetic-retry");
  assert.equal(await agentSave.isEnabled(), true);
  assert.equal(agentKey, "synthetic-draft");
  await agentSwitch.click();
  await page.getByText("无法更新 Tavily 状态。", { exact: true }).waitFor();
  assert.equal(await agentSwitch.getAttribute("aria-checked"), "true");
  pass("Agent failed key save retains draft and failed toggle restores the previous state");

  agentFailWrite = false;
  const remountWriteEntered = new Promise((done) => {
    agentWriteEntered = done;
  });
  agentWriteGate = new Promise((done) => {
    releaseWrite = done;
  });
  await agentSave.click();
  await remountWriteEntered;
  await page.getByRole("button", { name: "Leave fixture", exact: true }).click();
  await page.getByRole("button", { name: "Agent fixture", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#tavily-api-key")?.value === "synthetic-draft",
  );
  releaseWrite();
  agentWriteGate = null;
  agentWriteEntered = null;
  await page.waitForFunction(
    () => document.querySelector("#tavily-api-key")?.value === "synthetic-retry",
  );
  assert.equal(await agentSave.isDisabled(), true);
  pass("Agent save finishing after navigation refreshes the newly mounted settings");
  await page.screenshot({ path: path.join(evidence, "agent-settings.png") });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    JSON.stringify({ checks, errors, unexpected, requests }, null, 2),
  );
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser?.close();
  await server.close();
}
