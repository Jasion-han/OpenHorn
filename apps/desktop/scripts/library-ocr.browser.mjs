import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = "http://127.0.0.1:19437";
process.env.VITE_API_BASE = api;
process.chdir(desktop);
const { getLibraryLabel: label } = await import("../src/lib/i18n/agent.ts");
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: 31000 + Math.floor(Math.random() * 15000),
    watch: null,
    hmr: false,
  },
});
let browser;
let checks = 0;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const document = {
    id: "ocr-browser-document",
    projectId: null,
    fileName: "scan.png",
    fileType: "image/png",
    fileSize: 12,
    status: "failed",
    errorCode: "library_cloud_required",
    text: "",
    chunkCount: 0,
    revision: 1,
    canIndex: true,
    canOcr: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let ocrCalls = 0,
    finish;
  let mode = "success";
  const errors = [],
    unexpected = [];
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== api) {
      unexpected.push(url.href);
      return route.abort();
    }
    const send = (data, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204 });
    if (url.pathname === "/library") return send({ documents: [document] });
    if (url.pathname === `/library/${document.id}`) return send({ document });
    if (url.pathname === `/library/${document.id}/ocr`) {
      ocrCalls++;
      if (mode === "held")
        await new Promise((resolve) => {
          finish = resolve;
        });
      if (mode === "failure") return send({ errorCode: "library_unavailable" }, 500);
      document.status = "ready";
      document.canOcr = false;
      document.errorCode = null;
      document.text = "Synthetic OCR searchable text";
      document.chunkCount = 1;
      return send({ document });
    }
    if (url.pathname === "/projects") return send({ projects: [] });
    if (url.pathname === "/conversations") return send({ conversations: [] });
    if (url.pathname === "/channels") return send({ channels: [] });
    return send({});
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/tests/library.html`);
  await page.getByRole("heading", { name: "scan.png" }).waitFor();
  assert.equal(ocrCalls, 0);
  checks++;
  const menu = async () => {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    return page.getByRole("menuitem", { name: label("library.ocr.action"), exact: true });
  };
  const action = await menu();
  assert.equal(await action.count(), 1);
  checks++;
  const isLight = (color) =>
    color
      .match(/[\d.]+/g)
      .map(Number)
      .slice(0, 3)
      .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0) > 180;
  assert.equal(
    isLight(
      await page.getByRole("menu").evaluate((element) => getComputedStyle(element).backgroundColor),
    ),
    true,
  );
  checks++;
  await action.hover();
  const color = await action.evaluate((element) => getComputedStyle(element).backgroundColor);
  const rgb = color.match(/[\d.]+/g).map(Number);
  assert.equal(
    rgb.slice(0, 3).every((part) => part > 180),
    true,
  );
  checks++;
  await action.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(
    isLight(await dialog.evaluate((element) => getComputedStyle(element).backgroundColor)),
    true,
  );
  checks++;
  assert.equal(ocrCalls, 0);
  checks++;
  const confirm = dialog.getByRole("button", { name: label("library.ocr.confirm"), exact: true });
  assert.equal(await confirm.isDisabled(), true);
  checks++;
  await dialog.getByRole("checkbox").check();
  assert.equal(
    isLight(
      await dialog
        .getByRole("checkbox")
        .evaluate((element) => getComputedStyle(element).accentColor),
    ),
    true,
  );
  checks++;
  assert.equal(await confirm.isEnabled(), true);
  checks++;
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(ocrCalls, 0);
  checks++;
  await (await menu()).click();
  assert.equal(await dialog.getByRole("checkbox").isChecked(), false);
  checks++;
  await dialog.getByRole("checkbox").check();
  mode = "failure";
  await confirm.click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(ocrCalls, 1);
  checks++;
  assert.equal(await dialog.isVisible(), true);
  checks++;
  mode = "held";
  await confirm.click();
  await page.waitForFunction(
    () => window.document.querySelector('[role="dialog"] button[type="submit"]')?.disabled,
  );
  assert.equal(await dialog.getByRole("checkbox").isDisabled(), true);
  checks++;
  // Leaving during a paid call cannot let the old continuation change another view.
  await page.evaluate(() => window.libraryTest.leave());
  finish();
  await page.waitForTimeout(80);
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks++;
  await page.evaluate(() => window.libraryTest.back());
  await page.getByText("Synthetic OCR searchable text", { exact: true }).waitFor();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  assert.equal(
    await page.getByRole("menuitem", { name: label("library.ocr.action"), exact: true }).count(),
    0,
  );
  checks++;
  assert.equal(ocrCalls, 2);
  checks++;
  assert.deepEqual(errors, []);
  checks++;
  assert.deepEqual(unexpected, []);
  checks++;
  console.log(JSON.stringify({ checks, labels: "actual agent.ts dictionary" }));
} finally {
  await browser?.close();
  await server.close();
}
