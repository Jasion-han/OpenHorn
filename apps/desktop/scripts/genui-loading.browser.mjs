/** Production split-chunk lifecycle: node apps/desktop/scripts/genui-loading.browser.mjs */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const output = await mkdtemp(join(tmpdir(), "openhorn-genui-loading-"));
let server;
let browser;
try {
  await build({
    entryPoints: [join(appRoot, "scripts/fixtures/genui-loading.tsx")],
    outdir: output,
    bundle: true,
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (/^\/(?:genui-loading\.js|chunks\/[\w-]+\.(?:js|css))$/.test(pathname)) {
      response.setHeader(
        "Content-Type",
        extname(pathname) === ".css" ? "text/css" : "text/javascript",
      );
      response.end(await readFile(join(output, pathname)));
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/genui-loading.js"></script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/chunks/GenUiBlock-*.js", async (route) => {
    requests += 1;
    await gate;
    await route.continue();
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.genUiLoadTest);
  assert.equal(requests, 0, "ordinary replies must not request the OpenUI runtime");
  const first = 'root=Text("First block")';
  const second = 'root=Col([Input($name,"Name"),Text("Second block")])\n$name="Initial"';
  await page.evaluate((programs) => window.genUiLoadTest.render(programs), [first, second]);
  await page.getByTestId("source").first().waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="source"]').length === 2,
  );
  // Remove both pending consumers and mount the remaining block before its import settles.
  await page.evaluate(() => window.genUiLoadTest.clear());
  await page.evaluate((program) => window.genUiLoadTest.render([program]), second);
  release();
  await page.getByText("Second block", { exact: true }).waitFor();
  assert.equal(requests, 1, "all pending blocks share one import");
  assert.equal(await page.getByText("First block", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("source").count(), 0);
  const input = page.getByRole("textbox", { name: "Name" });
  await input.fill("Edited");
  await page.evaluate(() => {
    window.retainedGenUiInput = document.querySelector("input");
  });
  await page.evaluate((program) => window.genUiLoadTest.render([program]), second);
  assert.equal(await input.inputValue(), "Edited");
  assert.equal(
    await page.evaluate(() => document.querySelector("input") === window.retainedGenUiInput),
    true,
    "loaded renderer must retain its component identity and edited controls",
  );
  await page.evaluate(() => window.genUiLoadTest.clear());
  await page.evaluate((program) => window.genUiLoadTest.render([program]), first);
  assert.equal(await page.getByText("First block", { exact: true }).count(), 1);
  assert.equal(await page.getByTestId("source").count(), 0, "cached mounts render immediately");
  assert.deepEqual(errors, []);
  console.log(
    "PASS demand-only shared loading, pending unmount cleanup and stable cached identity",
  );

  const failed = await browser.newPage();
  const failureErrors = [];
  failed.on("pageerror", (error) => failureErrors.push(error.message));
  let rejectChunk;
  let failedRequests = 0;
  const rejection = new Promise((resolve) => {
    rejectChunk = resolve;
  });
  await failed.route("**/chunks/GenUiBlock-*.js", async (route) => {
    failedRequests += 1;
    await route.abort("failed");
    rejectChunk();
  });
  await failed.goto(url);
  await failed.waitForFunction(() => !!window.genUiLoadTest);
  await failed.evaluate((program) => window.genUiLoadTest.render([program]), first);
  await rejection;
  await failed.getByTestId("source").waitFor();
  assert.match(await failed.getByTestId("source").innerText(), /First block/);
  await failed.evaluate((program) => window.genUiLoadTest.render([program]), first);
  assert.equal(failedRequests, 1, "retained failed consumers must not busy-retry imports");
  assert.deepEqual(failureErrors, [], "a missing chunk must retain readable source, not crash");
  await failed.unroute("**/chunks/GenUiBlock-*.js");
  // Keep the original failed consumer mounted; a new consumer retries the import.
  await failed.evaluate((programs) => window.genUiLoadTest.render(programs), [first, second]);
  await failed.getByText("Second block", { exact: true }).waitFor();
  assert.equal(
    await failed.getByTestId("source").count(),
    0,
    "a successful shared retry must also recover the retained failed consumer",
  );
  await failed.getByText("First block", { exact: true }).waitFor();
  await failed.evaluate(() => window.genUiLoadTest.clear());
  await failed.getByText("Ordinary reply.", { exact: true }).waitFor();
  assert.deepEqual(failureErrors, []);
  console.log(
    "PASS rejected chunks retain source without polling; a shared retry recovers retained and new consumers",
  );

  const policyPage = await browser.newPage();
  const policyErrors = [];
  const policyChunks = [];
  policyPage.on("pageerror", (error) => policyErrors.push(error.message));
  policyPage.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/chunks/")) {
      policyChunks.push(request.url());
    }
  });
  await policyPage.goto(url);
  await policyPage.waitForFunction(() => !!window.genUiLoadTest);
  assert.equal(await policyPage.evaluate(() => window.genUiLoadTest.isAuto()), true);
  await policyPage.evaluate(() => window.genUiLoadTest.setAuto(false));
  const initiallyLoaded = [...policyChunks];
  const textOnly = await policyPage.evaluate(() => window.genUiLoadTest.policy());
  assert.match(textOnly, /^## Response format: text only/);
  assert.match(textOnly, /Normal source-code fences are allowed/);
  assert.match(textOnly, /Do not emit openui-lang, openui, or html-ui UI fences/);
  assert.match(textOnly, /not tool use/);
  assert.ok(textOnly.length < 1000, "Text only should not carry the full component schema");
  assert.deepEqual(policyChunks, initiallyLoaded, "Text only must not import any dynamic chunks");
  await policyPage.reload();
  await policyPage.waitForFunction(() => !!window.genUiLoadTest);
  assert.equal(await policyPage.evaluate(() => window.genUiLoadTest.isAuto()), false);
  const reloadedChunks = [...policyChunks];
  assert.equal(await policyPage.evaluate(() => window.genUiLoadTest.policy()), textOnly);
  assert.deepEqual(policyChunks, reloadedChunks, "persisted Text only stays lightweight");

  // Output preference must not gate rendering an existing answer.
  await policyPage.evaluate((program) => window.genUiLoadTest.render([program]), first);
  await policyPage.getByText("First block", { exact: true }).waitFor();
  assert.equal(await policyPage.evaluate(() => window.genUiLoadTest.isAuto()), false);
  await policyPage.evaluate(() => window.genUiLoadTest.clear());
  const policies = await policyPage.evaluate(async () => {
    const readPolicy = window.genUiLoadTest.policy;
    window.genUiLoadTest.setAuto(true);
    const auto = await readPolicy();
    window.genUiLoadTest.setAuto(false);
    return { auto, textOnly: await readPolicy() };
  });
  assert.match(policies.auto, /## Interactive answers/);
  assert.match(policies.auto, /Most answers need no UI/);
  assert.match(policies.auto, /Honor explicit requests for plain text/);
  assert.match(policies.auto, /never substitute an inline widget for execution/);
  assert.ok(policies.auto.length > textOnly.length);
  assert.equal(policies.textOnly, textOnly, "a retained reader must use the current preference");
  assert.deepEqual(policyErrors, []);
  await policyPage.close();
  console.log(
    "PASS Auto default, explicit Text-only persistence, no policy chunk loads, live preference changes and historical rendering",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
