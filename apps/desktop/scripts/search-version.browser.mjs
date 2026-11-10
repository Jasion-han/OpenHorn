import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence =
  process.env.OPENHORN_SEARCH_VERSION_EVIDENCE || "/tmp/openhorn-search-version-evidence";
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
  const spec = {
    title: "Needle recipe",
    description: "Synthetic recipe",
    promptTemplate: "Old Needle task",
    parameters: [],
    requirements: { skills: [], mcpServers: [], workspace: false, webSearch: false },
    outputFormat: "markdown",
  };
  const recipe = (await json("/recipes", "POST", { spec })).recipe;
  await json(`/recipes/${recipe.id}`, "PUT", {
    spec: { ...spec, promptTemplate: "New Needle task" },
    expectedVersion: 1,
  });
  const artifact = await json("/artifacts", "POST", {
    title: "Needle report",
    content: "# Needle report\nFirst line",
  });
  await json(`/artifacts/${artifact.artifact.id}/versions`, "POST", {
    expectedVersion: 1,
    content: "# Needle report\nSecond line\n<script>window.unsafeVersionExecuted=true</script>",
  });
  await json("/artifacts", "POST", { title: "Needle side", content: "A separate Needle result" });
  await json("/projects", "POST", { name: "Needle project", rootPath: "/synthetic/needle" });
  await json("/review-workspaces", "POST", {
    title: "Needle reviews",
    csv: "text\nSynthetic feedback",
    fileName: "synthetic.csv",
    delimiter: ",",
    textColumn: 0,
    ratingColumn: null,
  });
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
  let conversationRead = null,
    conversationEntered;
  let held = null,
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
    if (url.pathname === "/conversations" && request.method() === "GET" && conversationRead) {
      conversationEntered?.();
      await conversationRead;
    }
    if (url.pathname.endsWith("/restore") && held) {
      entered?.();
      await held;
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/search-version.html`);
  const search = async (query) => {
    await page.getByRole("button", { name: "统一搜索", exact: true }).click();
    await page.getByRole("textbox", { name: "统一搜索", exact: true }).fill(query);
    await page.getByTestId("unified-search-results").waitFor();
  };
  const artifactAction = async (name) => {
    await page.getByRole("button", { name: "更多成果操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  const recipeAction = async (name) => {
    await page.getByRole("button", { name: "更多配方操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
  };
  await search("Needle");
  for (const kind of ["conversation", "message", "artifact", "recipe", "project", "reviews"])
    assert.ok((await page.locator(`[data-search-kind="${kind}"]`).count()) > 0);
  await page.screenshot({ path: path.join(evidence, "unified-search.png") });
  pass("one existing search entry groups all six owned content types through the real API");
  await page.locator('[data-search-kind="artifact"]').filter({ hasText: "Needle report" }).click();
  await page.getByRole("heading", { name: "Needle report", exact: true, level: 2 }).waitFor();
  assert.equal(await page.getByRole("button", { name: "恢复为新版本", exact: true }).count(), 0);
  await artifactAction("版本历史");
  await page.getByLabel("版本", { exact: true }).selectOption("1");
  await page
    .locator("header span")
    .filter({ hasText: /^版本 1$/ })
    .waitFor();
  await page.getByText("与当前版本对比", { exact: true }).click();
  const comparison = page.getByTestId("version-comparison");
  await comparison.getByText(/Second line/).waitFor();
  assert.ok((await comparison.textContent()).includes("First line"));
  assert.equal(await page.evaluate(() => window.unsafeVersionExecuted), undefined);
  pass(
    "search opens the requested artifact and history compares escaped text without executing HTML",
  );
  const restoresBefore = requests.filter((r) => r.path.endsWith("/restore")).length;
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  assert.equal(requests.filter((r) => r.path.endsWith("/restore")).length, restoresBefore);
  let release;
  const started = new Promise((done) => {
    entered = done;
  });
  held = new Promise((done) => {
    release = done;
  });
  await page.getByRole("button", { name: "确认恢复", exact: true }).dblclick({ delay: 10 });
  await started;
  assert.equal(requests.filter((r) => r.path.endsWith("/restore")).length, restoresBefore + 1);
  release();
  held = null;
  entered = null;
  await page.waitForFunction(() => document.querySelector("#artifact-version")?.value === "3");
  const saved = await json(`/artifacts/${artifact.artifact.id}`);
  assert.equal(saved.version.content, artifact.version.content);
  assert.equal(saved.versions.length, 3);
  pass("restore confirmation creates one new immutable artifact version despite double clicking");
  await page.getByLabel("版本", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).waitFor();
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  await page
    .getByText("将版本 1 的完整内容另存为版本 4。已有历史和定时任务保持原样。", { exact: true })
    .waitFor();
  await json(`/artifacts/${artifact.artifact.id}/versions`, "POST", {
    expectedVersion: 3,
    content: "Remote newer version",
  });
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByTestId("version-restore").getByRole("alert").waitFor();
  assert.equal((await json(`/artifacts/${artifact.artifact.id}`)).artifact.currentVersion, 4);
  assert.equal(await page.getByLabel("版本", { exact: true }).inputValue(), "1");
  await page.getByRole("button", { name: "刷新版本", exact: true }).click();
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#artifact-version")?.value === "5");
  assert.equal(
    (await json(`/artifacts/${artifact.artifact.id}?version=4`)).version.content,
    "Remote newer version",
  );
  pass(
    "a concurrent update rejects restore, preserves the selected history and supports a fresh explicit retry",
  );
  await page.getByLabel("版本", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  const lateStarted = new Promise((done) => {
    entered = done;
  });
  held = new Promise((done) => {
    release = done;
  });
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await lateStarted;
  await search("Needle side");
  await page.locator('[data-search-kind="artifact"]').filter({ hasText: "Needle side" }).click();
  await page.getByRole("heading", { name: "Needle side", exact: true, level: 2 }).waitFor();
  const lateFinished = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/restore"));
  release();
  held = null;
  entered = null;
  await lateFinished;
  await page
    .getByRole("button", { name: "在新会话继续修改", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("heading", { name: "Needle side", exact: true, level: 2 }).count(),
    1,
  );
  await page
    .locator("header span")
    .filter({ hasText: /^版本 1$/ })
    .waitFor();
  assert.equal((await json(`/artifacts/${artifact.artifact.id}`)).artifact.currentVersion, 6);
  pass(
    "a restore finishing after another search navigation cannot apply its version to the newly opened artifact",
  );
  await search("Needle recipe");
  await page.locator('[data-search-kind="recipe"]').filter({ hasText: "Needle recipe" }).click();
  await page.getByRole("heading", { name: "Needle recipe", exact: true }).waitFor();
  await recipeAction("查看历史版本");
  await page.getByLabel("配方历史版本", { exact: true }).selectOption("1");
  await page.getByText("与当前版本对比", { exact: true }).click();
  assert.ok(
    (await page.getByTestId("version-comparison").textContent()).includes("New Needle task"),
  );
  await page.getByRole("button", { name: "恢复为新版本", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByRole("button", { name: "运行一次", exact: true }).waitFor();
  const restoredRecipe = await json(`/recipes/${recipe.id}`);
  assert.equal(restoredRecipe.recipe.version, 3);
  assert.equal(restoredRecipe.recipe.spec.promptTemplate, "Old Needle task");
  assert.equal(
    restoredRecipe.versions.find((v) => v.version === 2).spec.promptTemplate,
    "New Needle task",
  );
  pass("recipe restoration includes its full saved spec and preserves the intervening revision");
  await search("Needle reviews");
  await page.locator('[data-search-kind="reviews"]').click();
  await page.getByRole("heading", { name: "Needle reviews", exact: true }).waitFor();
  await search("Needle project");
  await page.locator('[data-search-kind="project"]').click();
  await page.getByRole("heading", { name: "Synthetic welcome", exact: true }).waitFor();
  await search("Needle message");
  await page.locator('[data-search-kind="message"]').click();
  await page.getByRole("heading", { name: "Needle conversation", exact: true }).waitFor();
  pass(
    "unified results navigate to review projects, local project scope and the owning conversation",
  );
  await json("/conversations", "POST", {
    title: "Fresh remote conversation",
    defaultMode: "chat",
    forceNew: true,
  });
  await search("Fresh remote conversation");
  await page.locator('[data-search-kind="conversation"]').click();
  await page.getByRole("heading", { name: "Fresh remote conversation", exact: true }).waitFor();
  pass(
    "a conversation created outside the current client is refreshed and opens from unified search",
  );
  await search("Needle conversation");
  let releaseRead;
  const readStarted = new Promise((done) => {
    conversationEntered = done;
  });
  conversationRead = new Promise((done) => {
    releaseRead = done;
  });
  await page.locator('[data-search-kind="conversation"]').click();
  await readStarted;
  await page.keyboard.press("Meta+n");
  await page.getByRole("heading", { name: "Synthetic welcome", exact: true }).waitFor();
  const readFinished = page.waitForResponse((r) => new URL(r.url()).pathname === "/conversations");
  releaseRead();
  conversationRead = null;
  conversationEntered = null;
  await readFinished;
  await page.waitForTimeout(100);
  assert.equal(
    await page.getByRole("heading", { name: "Synthetic welcome", exact: true }).count(),
    1,
  );
  pass(
    "starting a new conversation while a search navigation refresh is delayed cancels the old handoff",
  );
  await search("Needle conversation");
  await json("/conversations/search-version-conversation", "DELETE");
  await page.locator('[data-search-kind="conversation"]').click();
  await page.getByText("无法打开搜索结果", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "统一搜索", exact: true }).press("Escape");
  pass(
    "a deleted conversation result gives explicit feedback without silently opening an empty chat",
  );
  await search("Needle side");
  const side = (await json("/artifacts")).artifacts.find((a) => a.title === "Needle side");
  await json(`/artifacts/${side.id}`, "DELETE");
  await page.locator('[data-search-kind="artifact"]').click();
  await page
    .getByRole("alert")
    .getByText("内容已不存在，请刷新后重试。", { exact: true })
    .waitFor();
  pass("a deleted result reports an error rather than silently opening another saved artifact");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(
    requests.some((r) => /\/prepare$|\/schedule$|\/jev-runs$|\/verify-note$/.test(r.path)),
    false,
  );
  await writeFile(
    path.join(evidence, "results.json"),
    `${JSON.stringify({ checks, errors, unexpected, requests }, null, 2)}\n`,
  );
  console.log(`Evidence: ${evidence}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  child.kill("SIGTERM");
}
