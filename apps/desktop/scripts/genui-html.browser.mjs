// Actual-component regressions. Run with Node; optionally set
// PLAYWRIGHT_CHROMIUM_EXECUTABLE to an installed Chromium executable.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const vite = require.resolve("vite", { paths: [desktopRoot] });
const { build } = require(require.resolve("esbuild", { paths: [vite] }));
const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { HtmlUiBlock } from "./src/components/chat/genui/HtmlUiBlock";
      import { useGenUiStore } from "./src/stores/genUiStore";
      import { usePreviewPanelStore } from "./src/stores/previewPanelStore";
      const root = createRoot(document.getElementById("root"));
      window.review = {
        render(code, streaming = false) { root.render(<HtmlUiBlock code={code} streaming={streaming} />); },
        snapshot() { return { request: useGenUiStore.getState().composerRequest, tabs: usePreviewPanelStore.getState().tabs }; },
        theme() { document.documentElement.classList.toggle("dark"); window.dispatchEvent(new Event("openhorn-theme-change")); }
      };
    `,
    loader: "tsx",
    resolveDir: desktopRoot,
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
  outfile: "/genui-html.js",
  logLevel: "silent",
});
const files = new Map(bundle.outputFiles.map((file) => [file.path.split("/").pop(), file.text]));
const pendingResponses = new Set();
const server = http.createServer((request, response) => {
  if (request.url === "/genui-html.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(files.get("genui-html.js"));
  } else if (request.url === "/genui-html.css") {
    response.setHeader("content-type", "text/css");
    response.end(files.get("genui-html.css"));
  } else if (request.url === "/external" || request.url === "/external-pending") {
    response.setHeader("content-type", "text/html");
    const document = `<!doctype html><script>
      window.focus();
      parent.postMessage({type:"openhorn-genui",action:"sendPrompt",text:"navigated document"},"*");
      parent.postMessage({type:"openhorn-genui",action:"openLink",url:"https://example.com/escaped"},"*");
    </script>`;
    if (request.url === "/external-pending") {
      pendingResponses.add(response);
      response.on("close", () => pendingResponses.delete(response));
      response.write(`${document}${" ".repeat(1024)}`);
    } else response.end(document);
  } else {
    response.end(
      '<!doctype html><link rel="stylesheet" href="/genui-html.css"><div id="root"></div><script src="/genui-html.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const reset = async () => {
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.review));
  };
  const render = (code, streaming = false) =>
    page.evaluate(({ code, streaming }) => window.review.render(code, streaming), {
      code,
      streaming,
    });
  const snapshot = () => page.evaluate(() => window.review.snapshot());
  // Opaque frames may issue their first network request before Playwright has
  // attached routing to the new frame target. Gate only the network fixtures
  // until an evaluation confirms instrumentation is attached; no timing sleep.
  const networkGate =
    '<script type="module">await new Promise(resolve => { window.beginNetworkScripts = resolve; });</script>';
  const beginNetworkScripts = async () => {
    const element = await page.locator("#root iframe").elementHandle();
    assert.ok(element);
    const frame = await element.contentFrame();
    assert.ok(frame);
    await frame.waitForFunction(() => typeof window.beginNetworkScripts === "function");
    await frame.evaluate(() => window.beginNetworkScripts());
  };
  const unchanged = async () => {
    const state = await snapshot();
    assert.equal(state.request, null);
    assert.deepEqual(state.tabs, []);
  };

  await reset();
  await render(`<p>Propose actions</p><script>
    window.focus();
    parent.postMessage({type:"openhorn-genui",action:"sendPrompt",text:"Review this follow-up",isTrusted:true,focused:true,nonce:"forged"},"*");
    openhorn.openLink({url:"https://example.com/review"});
    for(let i=0;i<20;i++) openhorn.sendPrompt({text:"replacement "+i});
  </script>`);
  const fill = page.getByRole("button", { name: "填入输入框", exact: true });
  const open = page.getByRole("button", { name: "打开链接", exact: true });
  await fill.waitFor();
  await open.waitFor();
  await unchanged();
  assert.equal(await page.getByText("Review this follow-up", { exact: true }).count(), 1);
  assert.equal(await page.getByText("https://example.com/review", { exact: true }).count(), 1);
  assert.equal(await fill.count(), 1);
  await fill.evaluate((button) => button.click());
  await unchanged();
  await fill.click();
  assert.equal((await snapshot()).request.text, "Review this follow-up");
  assert.deepEqual((await snapshot()).tabs, []);
  await open.click();
  assert.equal((await snapshot()).tabs[0].url, "https://example.com/review");
  console.log(
    "PASS focus/forged messages only propose; visible trusted parent clicks apply exact actions",
  );

  for (const [delay, destination] of [
    [0, "/external"],
    [80, "/external"],
    [0, "/external-pending"],
  ]) {
    await reset();
    await render(`<p>Navigation attempt</p><script>
      ${delay ? `setTimeout(() => { location.href=${JSON.stringify(destination)}; }, ${delay});` : `location.href=${JSON.stringify(destination)};`}
    </script>`);
    if (destination === "/external-pending") {
      // A destination can keep loading indefinitely. Until its load, even its
      // forged requests remain proposals and cannot perform host actions.
      await page.waitForFunction(
        () =>
          !document.querySelector("#root iframe") ||
          [...document.querySelectorAll("#root p")].some(
            (element) => element.textContent === "navigated document",
          ),
      );
      await unchanged();
      for (const response of pendingResponses) response.end();
    }
    await page.getByText("交互内容试图跳转到外部页面，已停止运行", { exact: true }).waitFor();
    assert.equal(await page.locator("#root iframe").count(), 0);
    assert.equal(await page.getByRole("button").count(), 0);
    await unchanged();
  }
  console.log(
    "PASS immediate/delayed navigation revokes frames; pending destinations cannot act before load",
  );

  await reset();
  await page.context().route("https://cdn.jsdelivr.net/genui-regression.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'window.order.push("cdn");',
    }),
  );
  await page.context().route("https://cdn.jsdelivr.net/genui-module.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: 'export const value = "ready";',
    }),
  );
  await render(`<style>#status{height:420px}</style><p id="status"></p>${networkGate}
    <script>window.order=["before"];</script>
    <script src="https://cdn.jsdelivr.net/genui-regression.js"></script>
    <script>window.order.push("after");document.getElementById("status").textContent=order.join(",");</script>
    <script type="application/json">{"inert":true}</script>
    <script type="module">import {value} from "https://cdn.jsdelivr.net/genui-module.js";
      await Promise.resolve();document.getElementById("status").dataset.module=value;</script>
    <script nomodule src="https://cdn.jsdelivr.net/genui-regression.js"></script>
    <script>
      document.addEventListener("DOMContentLoaded", () => { document.getElementById("status").dataset.dom="ready"; });
      window.addEventListener("load", () => { document.getElementById("status").dataset.loaded="ready"; });
    </script>`);
  await beginNetworkScripts();
  const status = page.frameLocator("#root iframe").locator("#status");
  await status.filter({ hasText: "before,cdn,after" }).waitFor();
  await page.waitForFunction(() => document.querySelector("#root iframe")?.offsetHeight >= 420);
  await page
    .frameLocator("#root iframe")
    .locator('#status[data-module="ready"][data-dom="ready"][data-loaded="ready"]')
    .waitFor();
  assert.equal(await status.getAttribute("data-module"), "ready");
  assert.equal(await status.textContent(), "before,cdn,after");
  assert.deepEqual(await status.evaluate(() => window.order), ["before", "cdn", "after"]);
  assert.equal(await page.locator("#root iframe").getAttribute("sandbox"), "allow-scripts");
  console.log(
    "PASS markup/styles, ordered CDN/inline scripts, JSON/modules, DOMContentLoaded/load and height",
  );

  await reset();
  await page
    .context()
    .route("https://cdn.jsdelivr.net/genui-module-missing.js", (route) =>
      route.fulfill({ status: 404, contentType: "text/javascript", body: "" }),
    );
  await render(`<p id="status">waiting</p>${networkGate}
    <script type="module">import "https://cdn.jsdelivr.net/genui-module-missing.js";</script>
    <script type="module">await Promise.reject(new Error("expected module rejection"));</script>
    <script>
      document.addEventListener("DOMContentLoaded", () => { document.getElementById("status").dataset.dom="ready"; });
      window.addEventListener("load", () => { document.getElementById("status").dataset.loaded="ready"; });
      document.getElementById("status").textContent="After failed modules";
    </script>`);
  await beginNetworkScripts();
  await page
    .frameLocator("#root iframe")
    .locator('#status[data-dom="ready"][data-loaded="ready"]')
    .filter({ hasText: "After failed modules" })
    .waitFor();
  assert.deepEqual(errors, ["expected module rejection"]);
  errors.length = 0;
  console.log(
    "PASS failed module imports and rejected top-level await do not block later scripts/readiness",
  );

  await reset();
  const code =
    '<p id="status" style="height:180px">Preview</p><script>document.getElementById("status").textContent="Running";</script>';
  await render(code, true);
  await page.frameLocator("#root iframe").getByText("Preview", { exact: true }).waitFor();
  assert.equal(await page.locator("#root iframe").getAttribute("sandbox"), "");
  await unchanged();
  await render(code, false);
  await page.frameLocator("#root iframe").getByText("Running", { exact: true }).waitFor();
  await page.evaluate(() => window.review.theme());
  await page.frameLocator("#root iframe").getByText("Running", { exact: true }).waitFor();
  assert.equal(await page.locator("#root iframe").count(), 1);
  await unchanged();
  assert.deepEqual(errors, []);
  console.log(
    "PASS streaming preview stays inert, completion/theme reload bootstrap safely, no runtime errors",
  );
} finally {
  for (const response of pendingResponses) response.end();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
