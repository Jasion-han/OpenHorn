import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const evidence = process.env.OPENHORN_TOOL_UI_EVIDENCE || "/tmp/openhorn-search-ui-evidence";
await mkdir(evidence, { recursive: true });
const server = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
let browser;
const checks = [],
  errors = [],
  unexpected = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let nativeFeatureAvailable = true;
let routerFeatureAvailable = true;
let failRead = true,
  failWrite = false,
  verificationError = "search_endpoint_unsupported",
  revision = 0,
  verificationCalls = 0;
let verificationGate = null,
  configurationGate = null,
  configurationEntered = null,
  lastActivationRevision = null;
const values = {
  "liveSearch.tavilyApiKey": "synthetic-tavily",
  "liveSearch.provider": "auto",
  "deepseek.nativeWebEnabled": "true",
};
let status = {
  configured: true,
  source: "user",
  selectedProvider: "auto",
  effectiveProvider: "tavily",
  verification: "unverified",
  pendingProviders: [],
  availableProviders: [],
  configuredProviders: ["tavily"],
  revision: "0",
};
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1180, height: 1050 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (
      url.port !== "3002" ||
      (!url.pathname.startsWith("/settings") && url.pathname !== "/channels")
    ) {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    };
    const json = (body, code = 200) =>
      route.fulfill({
        status: code,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() === "OPTIONS") return json({});
    if (url.pathname === "/channels") {
      unexpected.push("chat channel listing should not be used by Search settings");
      return json({ channels: [] });
    }
    if (url.pathname === "/settings/tool-status")
      return json({
        configured: true,
        kind: "openrouter",
        endpoint: "https://openrouter.ai/api/v1",
        connectionToken: "fixture-connection",
      });
    if (url.pathname === "/settings/search-configuration") {
      if (failRead) return json({}, 500);
      const snapshot = JSON.parse(
        JSON.stringify({
          settings: values,
          status,
          nativeSearchAvailable: nativeFeatureAvailable,
          openRouterSearchAvailable: routerFeatureAvailable,
          nativeChannels: [
            {
              channelId: "fixture-official-native",
              name: "Official DeepSeek retrieval",
              model: "deepseek-v4-pro",
            },
          ],
        }),
      );
      configurationEntered?.();
      if (configurationGate) await configurationGate;
      return json(snapshot);
    }
    if (url.pathname === "/settings/search-status") return failRead ? json({}, 500) : json(status);
    if (url.pathname === "/settings/search/verify-and-activate") {
      verificationCalls++;
      const { provider, revision: expected } = request.postDataJSON();
      lastActivationRevision = expected;
      if (verificationGate) await verificationGate;
      if (expected !== status.revision)
        return json({ success: false, errorCode: "search_configuration_changed" });
      if (verificationError && provider !== "duckduckgo")
        return json({ success: false, errorCode: verificationError });
      values["liveSearch.provider"] = provider;
      const available = status.availableProviders ?? [];
      const configured = status.configuredProviders ?? [];
      status = {
        configured: true,
        source: provider === "tavily" ? "user" : provider,
        selectedProvider: provider,
        effectiveProvider: provider,
        verification: provider === "duckduckgo" ? "not_required" : "verified",
        pendingProviders: [],
        availableProviders:
          provider === "duckduckgo" ? available : [...new Set([...available, provider])],
        configuredProviders: [...new Set([...configured, provider])],
        revision: String(++revision),
      };
      if (provider === "deepseek-native") {
        const config = JSON.parse(values["deepseek.nativeSearchConnection"]);
        status.nativeConnection = {
          source: config.source,
          model: "deepseek-v4-pro",
          endpoint: "https://api.deepseek.com/v1",
          ...(config.source === "channel" ? { channelName: "Official DeepSeek retrieval" } : {}),
        };
      }
      if (provider === "openrouter")
        status.openRouterConnection = {
          model: "deepseek/deepseek-v4-flash",
          endpoint: "https://openrouter.ai/api/v1",
          engine: "exa",
        };
      return json({ success: true, status });
    }
    if (request.method() === "GET") return failRead ? json({}, 500) : json({ settings: values });
    if (failWrite) return json({}, 500);
    if (url.pathname === "/settings/search/native-connection") {
      values["deepseek.nativeSearchConnection"] = request.postDataJSON().value ?? "";
      status.revision = String(++revision);
      return json({ success: true });
    }
    if (url.pathname === "/settings/search/openrouter-connection") {
      values["openrouter.searchConnection"] = request.postDataJSON().value ?? "";
      status.revision = String(++revision);
      status.pendingProviders = ["openrouter"];
      return json({ success: true });
    }
    const settingKey = decodeURIComponent(url.pathname.slice("/settings/".length));
    values[settingKey] = request.postDataJSON().value ?? "";
    status.revision = String(++revision);
    return json({ success: true });
  });
  await page.goto(`${origin}/tests/deepseek-capabilities.html`, { timeout: 120_000 });
  const source = page.getByRole("combobox", { name: "搜索来源", exact: true });
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  const verify = page.getByRole("button", { name: "验证并启用", exact: true });
  const current = page.getByTestId("active-search-source");
  await page.getByRole("alert").filter({ hasText: "无法读取搜索设置" }).waitFor();
  assert.equal(await source.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "配置其他来源", exact: true }).isDisabled(),
    true,
  );
  failRead = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.getByRole("button", { name: "配置其他来源", exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "配置其他来源" && !button.disabled,
    ),
  );
  assert.equal(await source.isDisabled(), false);
  assert.equal(await page.getByLabel("Tavily API Key").count(), 1);
  await source.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), ["Tavily（待验证）"]);
  await page.keyboard.press("Escape");
  pass(
    "saved legacy Tavily stays visible with a pending-verification label; truly unconfigured sources stay hidden",
  );
  await page.getByRole("button", { name: "配置其他来源", exact: true }).click();
  assert.match(await current.innerText(), /当前搜索源：.*Tavily/);
  assert.equal(await page.getByRole("combobox").count(), 1);
  assert.equal(await page.getByRole("switch").count(), 0);
  assert.equal(await page.getByLabel("Tavily API Key").inputValue(), "synthetic-tavily");
  pass("one effective source is shown; failed initial loads are readonly and retryable");

  await source.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "Tavily",
    "DeepSeek 原生联网",
    "OpenRouter 联网",
    "DeepSeek 搜索接口",
    "DuckDuckGo",
  ]);
  const light = (color) => {
    const parts =
      color
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number) ?? [];
    return parts.length === 3 && parts.every((n) => n >= 150);
  };
  assert.equal(
    light(await page.getByRole("listbox").evaluate((el) => getComputedStyle(el).backgroundColor)),
    true,
  );
  await page.getByRole("option", { name: "DeepSeek 搜索接口", exact: true }).hover();
  assert.equal(
    light(
      await page
        .getByRole("option", { name: "DeepSeek 搜索接口", exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ),
    true,
  );
  await page.getByRole("option", { name: "DeepSeek 搜索接口", exact: true }).click();
  await source.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page
      .getByRole("option", { name: "DeepSeek 搜索接口", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Escape");
  assert.match(await current.innerText(), /Tavily/);
  assert.equal(verificationCalls, 0);
  pass(
    "source menu lists engines only; choosing one does not activate it; hover/selected/keyboard states stay light",
  );

  const key = page.getByLabel("API Key", { exact: true });
  assert.equal(await key.inputValue(), "");
  assert.equal(await page.getByLabel("接口地址", { exact: true }).isVisible(), false);
  assert.equal(await verify.isDisabled(), true);
  await key.fill("official-only");
  await page.getByText("修改接口地址", { exact: true }).click();
  const address = page.getByLabel("接口地址", { exact: true });
  assert.equal(await address.inputValue(), "https://api.deepseek.com/v1");
  await address.fill("https://relay.example.com/api/v1");
  assert.equal(await key.inputValue(), "");
  await key.fill("relay-only");
  assert.equal(await verify.isDisabled(), true);
  failWrite = true;
  await save.click();
  await page.getByRole("alert").filter({ hasText: "配置未保存" }).waitFor();
  assert.equal(await key.inputValue(), "relay-only");
  assert.equal(values["liveSearch.provider"], "auto");
  failWrite = false;
  await save.click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find((el) => el.textContent === "验证并启用")
        ?.disabled,
  );
  const storedManual = JSON.parse(values["deepseek.searchConnection"]);
  assert.equal(storedManual.kind, "deepseek");
  assert.equal(storedManual.baseUrl, "https://relay.example.com/api/v1");
  assert.equal(Object.hasOwn(storedManual, "model"), false);
  assert.equal(values["liveSearch.provider"], "auto");
  assert.match(await current.innerText(), /Tavily/);
  assert.equal(verificationCalls, 0);
  pass(
    "manual DeepSeek has only Key and folded address; save preserves source and never triggers a paid probe",
  );

  await verify.click();
  await page.getByRole("alert").filter({ hasText: "不支持所需搜索接口" }).waitFor();
  assert.match(await current.innerText(), /Tavily/);
  assert.equal(await key.inputValue(), "relay-only");
  verificationError = "search_invalid_response";
  await verify.click();
  await page.getByRole("alert").filter({ hasText: "普通模型回复不能作为搜索验证" }).waitFor();
  assert.match(await current.innerText(), /Tavily/);
  pass(
    "unsupported endpoints and chat replies show explicit failure while keeping the working source",
  );

  verificationError = null;
  let releaseVerification;
  verificationGate = new Promise((resolve) => {
    releaseVerification = resolve;
  });
  const callsBefore = verificationCalls;
  await verify.click();
  await page.getByRole("button", { name: "正在验证…", exact: true }).waitFor();
  assert.equal(await source.isDisabled(), true);
  assert.equal(await key.isDisabled(), true);
  await page.waitForFunction(() => document.querySelector("#search-source")?.disabled);
  releaseVerification();
  verificationGate = null;
  await page.getByRole("status").filter({ hasText: "已切换搜索来源" }).waitFor();
  assert.equal(verificationCalls, callsBefore + 1);
  assert.match(await current.innerText(), /DeepSeek/);
  assert.match(await current.innerText(), /搜索验证通过/);
  pass(
    "only successful explicit verification activates DeepSeek; duplicate submissions and edits are blocked",
  );

  await source.click();
  await page.getByRole("option", { name: "Tavily", exact: true }).click();
  const displayedRevision = status.revision;
  values["deepseek.searchConnection"] = JSON.stringify({
    ...storedManual,
    apiKey: "changed-during-refresh",
  });
  status.revision = String(++revision);
  let releaseConfiguration;
  configurationGate = new Promise((resolve) => {
    releaseConfiguration = resolve;
  });
  const configurationStarted = new Promise((resolve) => {
    configurationEntered = resolve;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await configurationStarted;
  configurationEntered = null;
  await source.click();
  await page.getByRole("option", { name: "DeepSeek 搜索接口", exact: true }).click();
  const finishedConfiguration = page.waitForResponse((res) =>
    res.url().endsWith("/settings/search-configuration"),
  );
  releaseConfiguration();
  configurationGate = null;
  await finishedConfiguration;
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find((el) => el.textContent === "验证并启用")
        ?.disabled,
  );
  assert.equal(await key.inputValue(), "relay-only");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/settings/search/verify-and-activate")),
    verify.click(),
  ]);
  assert.equal(lastActivationRevision, displayedRevision);
  await page.getByRole("alert").filter({ hasText: "配置或搜索来源已有变化" }).waitFor();
  await page.waitForFunction(
    () => document.querySelector("#deepseek-tools-key")?.value === "changed-during-refresh",
  );
  values["deepseek.searchConnection"] = JSON.stringify(storedManual);
  status.revision = String(++revision);
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.waitForFunction(
    () => document.querySelector("#deepseek-tools-key")?.value === "relay-only",
  );
  pass(
    "a late refresh cannot bind an unseen connection revision to the displayed form after a source switch",
  );

  await key.fill("unsaved-draft");
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.waitForFunction(
    () => document.querySelector("#deepseek-tools-key")?.value === "unsaved-draft",
  );
  assert.equal(await address.inputValue(), "https://relay.example.com/api/v1");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  assert.equal(await key.inputValue(), "relay-only");
  pass("reconnect preserves drafts and cancel restores the acknowledged saved configuration");

  await source.click();
  await page.getByRole("option", { name: "DuckDuckGo", exact: true }).click();
  assert.match(await current.innerText(), /DeepSeek/);
  const oldCalls = verificationCalls;
  await page.getByRole("button", { name: "启用此来源", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="active-search-source"]')
      ?.textContent.includes("DuckDuckGo"),
  );
  assert.equal(verificationCalls, oldCalls + 1);
  assert.equal(await page.getByLabel("API Key", { exact: true }).count(), 0);
  await source.click();
  await page.getByRole("option", { name: "DeepSeek 搜索接口", exact: true }).click();
  assert.equal(await key.inputValue(), "relay-only");
  pass(
    "switching to keyless DuckDuckGo is explicit and preserves the saved DeepSeek configuration",
  );

  const validStatus = status;
  status = { configured: true, source: "user" };
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "无法读取搜索设置" }).waitFor();
  assert.equal(await source.isDisabled(), true);
  assert.equal(await save.count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "配置其他来源", exact: true }).isDisabled(),
    true,
  );
  status = validStatus;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#search-source")?.disabled);
  await page.getByRole("button", { name: "配置其他来源", exact: true }).click();
  await source.click();
  await page.getByRole("option", { name: "DeepSeek 搜索接口", exact: true }).click();
  assert.equal(await key.inputValue(), "relay-only");
  pass(
    "an older or incomplete backend response blocks edits without crashing or overwriting configuration",
  );

  assert.equal(await page.getByText("高级联网设置", { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("switch", { name: "启用 DeepSeek 原生联网", exact: true }).count(),
    0,
  );
  await source.click();
  await page.getByRole("option", { name: "DeepSeek 原生联网", exact: true }).click();
  const nativeKey = page.getByLabel("DeepSeek 官方 API Key", { exact: true });
  assert.equal(await nativeKey.inputValue(), "");
  assert.equal(await verify.isDisabled(), true);
  assert.match(await page.locator("body").innerText(), /deepseek-v4-pro/);
  assert.match(await page.locator("body").innerText(), /可能产生模型及搜索费用/);
  await nativeKey.fill("native-manual-fixture");
  await save.click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(values["liveSearch.provider"], "duckduckgo");
  verificationError = "search_not_executed";
  await verify.click();
  await page.getByRole("alert").filter({ hasText: "未实际执行联网搜索" }).waitFor();
  assert.equal(values["liveSearch.provider"], "duckduckgo");
  verificationError = null;
  await verify.click();
  await page.getByRole("status").filter({ hasText: "已切换搜索来源" }).waitFor();
  assert.match(await current.innerText(), /DeepSeek 原生联网/);
  pass(
    "native retrieval is a peer source with explicit dedicated Key/model, no legacy override, and real-search verification required",
  );

  const credential = page.getByRole("combobox", { name: "联网凭据", exact: true });
  await credential.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "单独填写官方 Key",
    "Official DeepSeek retrieval · deepseek-v4-pro",
  ]);
  await page
    .getByRole("option", { name: "Official DeepSeek retrieval · deepseek-v4-pro", exact: true })
    .click();
  assert.equal(await nativeKey.count(), 0);
  assert.match(await page.locator("body").innerText(), /使用所选渠道保存的 Key/);
  await save.click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  const storedNative = JSON.parse(values["deepseek.nativeSearchConnection"]);
  assert.deepEqual(storedNative, {
    source: "channel",
    channelId: "fixture-official-native",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
  });
  await verify.click();
  await page.getByRole("status").filter({ hasText: "已切换搜索来源" }).waitFor();
  assert.match(
    await page.locator("body").innerText(),
    /当前联网连接： Official DeepSeek retrieval/,
  );
  assert.equal(values["deepseek.nativeWebEnabled"], "true");
  pass(
    "native credential reuse lists only the eligible retrieval channel and makes the actual active Key source visible without copying its secret",
  );
  await source.click();
  await page.getByRole("option", { name: "OpenRouter 联网", exact: true }).click();
  const routerKey = page.getByLabel("OpenRouter 搜索 API Key", { exact: true });
  assert.equal(await routerKey.inputValue(), "");
  assert.equal(await verify.isDisabled(), true);
  assert.match(await page.locator("body").innerText(), /Exa（经 OpenRouter 调用）/);
  assert.match(await page.locator("body").innerText(), /与 Jev 决策辅助及聊天渠道的 Key 分开/);
  assert.match(await current.innerText(), /DeepSeek 原生联网/);
  pass(
    "OpenRouter is a peer source with dedicated search Key, explicit DeepSeek model and Exa engine, isolated from Jev and chat credentials",
  );
  await routerKey.fill("router-search-fixture-only");
  failWrite = true;
  await save.click();
  await page.getByRole("alert").filter({ hasText: "配置未保存" }).waitFor();
  assert.equal(await routerKey.inputValue(), "router-search-fixture-only");
  assert.equal(values["openrouter.searchConnection"], undefined);
  failWrite = false;
  const callsBeforeRouterSave = verificationCalls;
  await save.click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(verificationCalls, callsBeforeRouterSave);
  assert.equal(values["liveSearch.provider"], "deepseek-native");
  assert.deepEqual(JSON.parse(values["openrouter.searchConnection"]), {
    apiKey: "router-search-fixture-only",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-v4-flash",
    engine: "exa",
  });
  pass(
    "OpenRouter failed saves preserve drafts and successful candidate saves never make a paid probe or change the active source",
  );
  verificationError = "search_no_results";
  await verify.click();
  await page.getByRole("alert").filter({ hasText: "未取得可用的网页来源" }).waitFor();
  assert.equal(values["liveSearch.provider"], "deepseek-native");
  verificationError = null;
  await verify.click();
  await page.getByRole("status").filter({ hasText: "已切换搜索来源" }).waitFor();
  assert.match(await current.innerText(), /OpenRouter 联网/);
  pass(
    "OpenRouter only activates after a source-backed explicit verification and failure preserves the original source",
  );
  await routerKey.fill("unsaved-router-edit");
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.waitForFunction(() => !document.querySelector("#search-source")?.disabled);
  assert.equal(await routerKey.inputValue(), "unsaved-router-edit");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  assert.equal(await routerKey.inputValue(), "router-search-fixture-only");
  assert.equal(await save.isDisabled(), true);
  pass(
    "OpenRouter reconnect keeps an unsaved draft and cancel restores the last acknowledged Key without touching Jev",
  );
  const flashConfig = values["openrouter.searchConnection"];
  const flashStatus = structuredClone(status);
  values["openrouter.searchConnection"] = JSON.stringify({
    ...JSON.parse(flashConfig),
    model: "deepseek/deepseek-v4-pro",
  });
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByText(/联网模型： deepseek\/deepseek-v4-pro/).waitFor();
  await routerKey.fill("updated-legacy-key");
  await save.click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(JSON.parse(values["openrouter.searchConnection"]).model, "deepseek/deepseek-v4-pro");
  values["openrouter.searchConnection"] = flashConfig;
  status = flashStatus;
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByText(/联网模型： deepseek\/deepseek-v4-flash/).waitFor();
  pass(
    "legacy Pro is displayed truthfully and key edits preserve its model; new connections default to Flash",
  );
  routerFeatureAvailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByRole("alert").filter({ hasText: "当前后端不支持 OpenRouter 联网" }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await verify.isDisabled(), true);
  routerFeatureAvailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await routerKey.waitFor();
  assert.equal(await routerKey.inputValue(), "router-search-fixture-only");
  await page.screenshot({ path: path.join(evidence, "openrouter-search.png"), fullPage: true });
  pass(
    "a backend without the OpenRouter capability cannot accept its search Key through generic plaintext settings",
  );
  status.availableProviders = ["openrouter", "openrouter"];
  status.configuredProviders = ["tavily", "openrouter"];
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByRole("button", { name: "返回已配置连接", exact: true }).click();
  await source.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "Tavily（待验证）",
    "OpenRouter 联网",
  ]);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "已启用", exact: true }).isDisabled(), true);
  pass(
    "the main menu preserves configured Tavily beside OpenRouter, labels unknown verification and removes duplicates",
  );
  status.availableProviders = ["openrouter", "deepseek-native", "deepseek", "openrouter"];
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.waitForFunction(() => !document.querySelector("#search-source")?.disabled);
  await source.click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "Tavily（待验证）",
    "OpenRouter 联网",
    "DeepSeek 原生联网",
  ]);
  await page.keyboard.press("Escape");
  pass("two verified DeepSeek protocols are represented by one main-menu entry");
  status.availableProviders = ["openrouter"];
  await page.getByRole("button", { name: "配置其他来源", exact: true }).click();
  await source.click();
  await page.getByRole("option", { name: "Tavily", exact: true }).click();
  nativeFeatureAvailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByRole("alert").filter({ hasText: "当前后端版本不支持统一联网配置" }).waitFor();
  assert.equal(await source.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(await verify.isDisabled(), true);
  nativeFeatureAvailable = true;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#search-source")?.disabled);
  pass(
    "older backend capabilities fail closed and cannot accept new credentials through generic unencrypted settings",
  );

  await page.getByText("联网过程", { exact: true }).click();
  await page.getByText("来源", { exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "Unsafe source" }).count(), 0);
  assert.equal(await page.getByRole("link", { name: /Synthetic official source/ }).count(), 2);
  await page.screenshot({
    path: path.join(evidence, "settings-and-references.png"),
    fullPage: true,
  });
  pass("native process and citations expand; unsafe URL is not rendered");

  await page.getByRole("button", { name: "Open OCR fixture", exact: true }).click();
  const dialog = page.getByRole("dialog"),
    confirm = dialog.getByRole("button", { name: "上传并识别文字", exact: true });
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.capabilityFixture.ocrCalls), 0);
  await dialog.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await confirm.click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => window.capabilityFixture.ocrCalls), 1);
  await page.screenshot({ path: path.join(evidence, "ocr-consent-and-error.png") });
  await page.evaluate(() => {
    window.capabilityFixture.failOcr = false;
  });
  await confirm.click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open OCR fixture", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "上传并识别文字", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.evaluate(() => window.capabilityFixture.ocrCalls), 2);
  pass("OCR needs per-dialog consent, keeps failure visible and never automatically retries");
  await page.setViewportSize({ width: 720, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    JSON.stringify(
      {
        checks,
        errors,
        unexpected,
        limitations:
          "Local browser fixture with intercepted settings and OCR callbacks; no real paid API calls.",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
