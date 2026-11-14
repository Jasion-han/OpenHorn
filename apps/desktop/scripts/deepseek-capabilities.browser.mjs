import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const evidence = "/tmp/openhorn-deepseek-ui-evidence";
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
let failRead = true,
  failWrite = false;
const values = {
  "deepseek.toolsApiKey": "",
  "liveSearch.provider": "auto",
  "deepseek.nativeWebEnabled": "false",
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
    if (url.port !== "3002" || !url.pathname.startsWith("/settings")) {
      unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, PUT, OPTIONS",
    };
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() === "OPTIONS") return json({});
    if (request.method() === "GET") return failRead ? json({}, 500) : json({ settings: values });
    if (failWrite) return json({}, 500);
    values[decodeURIComponent(url.pathname.slice("/settings/".length))] =
      request.postDataJSON().value ?? "";
    return json({ success: true });
  });
  await page.goto(`${origin}/tests/deepseek-capabilities.html`);
  const key = page.getByLabel("DeepSeek 工具 API Key", { exact: true });
  await page.getByRole("alert").filter({ hasText: "无法加载工具设置" }).waitFor();
  assert.equal(await key.isDisabled(), true);
  failRead = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await key.waitFor();
  await page.waitForFunction(() => !document.querySelector("#deepseek-tools-key")?.disabled);
  pass("failed initial load is retryable and cannot overwrite settings");

  await page.getByRole("combobox", { name: "搜索来源", exact: true }).click();
  const option = page.getByRole("option", { name: "DeepSeek", exact: true });
  await option.hover();
  const light = (color) => {
    const channels =
      color
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number) ?? [];
    return channels.length === 3 && channels.every((channel) => channel >= 150);
  };
  assert.equal(
    light(await page.getByRole("listbox").evaluate((el) => getComputedStyle(el).backgroundColor)),
    true,
  );
  assert.equal(light(await option.evaluate((el) => getComputedStyle(el).backgroundColor)), true);
  await option.click();
  await page.getByRole("combobox", { name: "搜索来源", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  const selected = page.getByRole("option", { name: "DeepSeek", exact: true });
  assert.equal(await selected.getAttribute("aria-selected"), "true");
  assert.equal(light(await selected.evaluate((el) => getComputedStyle(el).backgroundColor)), true);
  await page.keyboard.press("Escape");
  pass("expanded provider menu, hover, selected and keyboard states remain light");

  await page.getByRole("button", { name: "保存工具设置", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "填写工具 API Key" }).waitFor();
  await key.fill("synthetic-tools-never-sent");
  await page.getByRole("switch", { name: "启用 DeepSeek 原生联网", exact: true }).click();
  failWrite = true;
  await page.getByRole("button", { name: "保存工具设置", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "部分设置未保存" }).waitFor();
  assert.equal(await key.inputValue(), "synthetic-tools-never-sent");
  failWrite = false;
  await page.getByRole("button", { name: "保存工具设置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "工具设置已保存" }).waitFor();
  assert.equal(values["liveSearch.provider"], "deepseek");
  assert.equal(values["deepseek.nativeWebEnabled"], "true");
  pass("missing key validation, failed save draft and successful retry");
  await key.fill("synthetic-unsaved-draft");
  await page.evaluate(() => window.dispatchEvent(new Event("openhorn:backend-up")));
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  assert.equal(await key.inputValue(), "synthetic-tools-never-sent");
  pass("cancel returns to acknowledged baseline without discarding saved configuration");

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
