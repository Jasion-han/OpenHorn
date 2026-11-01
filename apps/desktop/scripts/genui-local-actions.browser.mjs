/** Local mode actions and truthful follow-up controls in actual Chat/Agent bubbles. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const bundle = await build({
  stdin: {
    contents: await readFile(resolve(desktop, "scripts/fixtures/genui-local-actions.tsx"), "utf8"),
    loader: "tsx",
    resolveDir: resolve(desktop, "scripts/fixtures"),
  },
  bundle: true,
  jsx: "automatic",
  platform: "browser",
  format: "iife",
  loader: { ".svg": "dataurl", ".png": "dataurl", ".ico": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  write: false,
  outfile: "/genui-local-actions.js",
  logLevel: "silent",
});
const files = new Map(bundle.outputFiles.map((file) => [file.path.split("/").pop(), file.text]));
const server = http.createServer((request, response) => {
  const name = request.url?.slice(1);
  if (name && files.has(name)) {
    response.setHeader(
      "Content-Type",
      name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
    );
    response.end(files.get(name));
  } else {
    response.end(
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/genui-local-actions.css"><div id="root"></div><script src="/genui-local-actions.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext();
  const base = `http://127.0.0.1:${server.address().port}`;
  const unwantedRequests = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === base &&
      ["/", "/genui-local-actions.js", "/genui-local-actions.css", "/favicon.ico"].includes(
        url.pathname,
      )
    ) {
      return route.continue();
    }
    unwantedRequests.push(url.toString());
    return route.abort();
  });
  await context.addInitScript(() => {
    window.localActionCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => window.localActionCopies.push(text) },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ready = () => page.waitForFunction(() => !!window.genUiLocalActions);
  await page.goto(base);
  await ready();
  const start = (mode, scope, kind = "mortgage") =>
    page.evaluate(
      ({ mode, scope, kind }) =>
        window.genUiControls.start(mode, window.genUiLocalActions[kind], scope),
      { mode, scope, kind },
    );
  const state = () => page.evaluate(() => window.genUiControls.state());
  const snapshot = () => page.evaluate(() => window.genUiControls.snapshot());
  const button = (name) => page.getByRole("button", { name, exact: true });
  const slider = (name) => page.getByRole("slider", { name, exact: true });
  const stat = async (name, expected) => {
    const value = await page
      .getByText(name, { exact: true })
      .locator("..")
      .locator("span")
      .nth(1)
      .innerText();
    assert.equal(Number(value.replace(/[^0-9.-]/g, "")), expected, `${name}: ${value}`);
  };
  const hint = async (name, expected) => {
    const control = button(name);
    assert.equal(
      (await control.innerText()).includes("填入输入框"),
      expected,
      `${name} should disclose its actual follow-up behavior`,
    );
    const descriptionId = await control.getAttribute("aria-describedby");
    if (expected) {
      assert.ok(descriptionId);
      assert.match(await page.locator(`[id="${descriptionId}"]`).textContent(), /不会自动发送/);
    } else {
      assert.equal(descriptionId, null);
    }
  };
  const hierarchy = async () => {
    // These headings live inside Markdown, whose prose h3 rules must not
    // override the compact Title component's spacing or font weight.
    for (const name of ["房贷月供计算器", "贷款设置", "结果（概要）", "计算要点"]) {
      const headingStyle = await page
        .getByRole("heading", { name, exact: true })
        .evaluate((heading) => {
          const style = getComputedStyle(heading);
          return {
            marginTop: style.marginTop,
            marginBottom: style.marginBottom,
            fontWeight: style.fontWeight,
          };
        });
      assert.deepEqual(
        headingStyle,
        { marginTop: "0px", marginBottom: "0px", fontWeight: "600" },
        `${name} keeps component typography inside Markdown`,
      );
    }
    const settings = page.getByRole("heading", { name: "贷款设置", exact: true }).locator("..");
    assert.equal(await settings.getByRole("group", { name: "还款方式", exact: true }).count(), 1);
    assert.equal(await settings.getByRole("slider").count(), 3);
    for (const name of ["贷款金额", "年利率", "年限"]) {
      assert.equal(await settings.getByRole("slider", { name, exact: true }).count(), 1);
    }
    const header = page.getByRole("heading", { name: "房贷月供计算器", exact: true }).locator("..");
    assert.equal(await header.getByRole("button").count(), 0);
    const results = page.getByRole("heading", { name: "结果（概要）", exact: true }).locator("..");
    const details = page.getByRole("heading", { name: "计算要点", exact: true }).locator("..");
    const followUp = button("请 AI 分析还款压力");
    const sections = await Promise.all(
      [settings, results, details, followUp].map((section) => section.boundingBox()),
    );
    for (let index = 0; index < sections.length - 1; index++) {
      assert.ok(sections[index] && sections[index + 1]);
      assert.ok(
        sections[index].y + sections[index].height <= sections[index + 1].y,
        "settings, immediate results, detail and optional follow-up stay in task order",
      );
    }
    const footer = await followUp.evaluate((control) => ({
      width: control.getBoundingClientRect().width,
      availableWidth: control.parentElement.getBoundingClientRect().width,
      background: getComputedStyle(control).backgroundColor,
    }));
    assert.ok(footer.width < footer.availableWidth, "AI follow-up keeps its intrinsic width");
    assert.equal(footer.background, "rgba(0, 0, 0, 0)", "AI follow-up is visually secondary");
  };

  for (const mode of ["chat", "agent"]) {
    const scope = `local-mortgage-${mode}`;
    await start(mode, scope);
    await button("等额本金").waitFor();
    await stat("每月还款", 4490);
    await stat("总还款", 1616561);
    await stat("总利息", 616561);
    await hint("等额本息", false);
    await hint("等额本金", false);
    await hint("请 AI 分析还款压力", true);
    await hierarchy();
    console.log(
      `PASS ${mode}: repayment mode and numerical inputs share one settings group, followed by results and an intrinsic secondary AI footer`,
    );
    await page.evaluate(() => window.genUiLocalActions.seedDraft("已有草稿，请保留"));
    let draft = (await snapshot()).request;
    const initial = {
      $mode: "等额本息",
      $amount: Number(await slider("贷款金额").inputValue()),
      $rate: Number(await slider("年利率").inputValue()),
      $years: Number(await slider("年限").inputValue()),
    };
    await button("等额本金").focus();
    await page.keyboard.press("Enter");
    assert.equal(await button("等额本金").getAttribute("aria-pressed"), "true");
    await stat("首月还款", 5694);
    await stat("总还款", 1526458);
    await stat("总利息", 526458);
    await stat("末月还款", 2785.88);
    await stat("每月递减", 8.1);
    assert.deepEqual(await state(), { ...initial, $mode: "等额本金" });
    assert.deepEqual((await snapshot()).request, draft);
    console.log(
      `PASS ${mode}: mode switches locally by keyboard with correct first/last/total values and no draft mutation`,
    );

    await slider("贷款金额").focus();
    await page.keyboard.press("ArrowRight");
    await slider("年利率").focus();
    await page.keyboard.press("ArrowRight");
    await slider("年限").focus();
    await page.keyboard.press("Home");
    const edited = { $mode: "等额本金", $amount: 1050000, $rate: 3.55, $years: 1 };
    assert.deepEqual(await state(), edited);
    await stat("首月还款", 90606);
    await stat("总利息", 20191);
    await button("等额本息").click();
    assert.deepEqual(await state(), { ...edited, $mode: "等额本息" });
    await button("等额本金").click();
    assert.deepEqual(await state(), edited);
    assert.deepEqual((await snapshot()).request, draft);
    await page.evaluate(() => window.genUiControls.remount());
    await button("等额本金").waitFor();
    assert.deepEqual(await page.evaluate(() => window.genUiControls.state(true)), edited);
    await page.reload();
    await ready();
    await start(mode, scope);
    await button("等额本金").waitFor();
    assert.deepEqual(await state(), edited);
    assert.equal(await button("等额本金").getAttribute("aria-pressed"), "true");
    await page.evaluate(() => {
      window.genUiControls.reconcile();
      window.genUiControls.remount();
    });
    await page.evaluate(() => window.genUiControls.reload());
    await button("等额本金").waitFor();
    assert.deepEqual(await state(), edited);
    console.log(
      `PASS ${mode}: adjusted parameters and mode survive toggles, remount, real storage reload and persisted ID reconciliation`,
    );

    await page.evaluate(() => window.genUiLocalActions.seedDraft("第二份已有草稿"));
    draft = (await snapshot()).request;
    await page.evaluate(() => window.genUiControls.incomplete());
    await page.waitForFunction(() => document.querySelector('#root input[type="range"]')?.disabled);
    for (const control of await page
      .locator("#root .genui_block input, #root .genui_block button")
      .all()) {
      assert.equal(await control.isDisabled(), true);
    }
    assert.deepEqual((await snapshot()).request, draft);
    await page.evaluate(() => window.genUiControls.stop());
    assert.equal(await button("等额本金").isDisabled(), true);
    await page.evaluate(() => window.genUiControls.finish());
    await button("等额本金").waitFor();
    assert.equal(await button("等额本金").isDisabled(), false);
    assert.deepEqual(await state(), edited);
    await slider("年限").focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await button("请 AI 分析还款压力").evaluate((control) => document.activeElement === control),
      true,
      "the optional AI footer is reachable after the calculator controls",
    );
    await page.keyboard.press("Enter");
    const request = (await snapshot()).request;
    assert.match(request.text, /^请结合我已提供的财务信息分析这笔房贷的还款压力/);
    assert.match(request.text, /如果缺少收入、固定支出或其他债务信息，请先向我确认，不要自行假设/);
    assert.match(request.text, /还款方式：等额本金/);
    assert.match(request.text, /1,050,000/);
    assert.match(request.text, /3.55%/);
    assert.match(request.text, /年限：1 年/);
    assert.deepEqual(await state(), edited);
    console.log(
      `PASS ${mode}: incomplete controls stay disabled; keyboard AI follow-up prepares a current-parameter draft that clarifies missing financial inputs`,
    );

    await start(mode, `zero-mortgage-${mode}`);
    await button("等额本金").waitFor();
    await slider("贷款金额").focus();
    await page.keyboard.press("Home");
    await slider("年利率").focus();
    await page.keyboard.press("Home");
    await slider("年限").focus();
    await page.keyboard.press("Home");
    for (let year = 1; year < 7; year++) await page.keyboard.press("ArrowRight");
    assert.deepEqual(await state(), { $mode: "等额本息", $amount: 100000, $rate: 0, $years: 7 });
    await stat("每月还款", 1190);
    await stat("总还款", 100000);
    await stat("总利息", 0);
    await button("等额本金").click();
    await stat("首月还款", 1190);
    await stat("末月还款", 1190.48);
    await stat("每月递减", 0);
    await stat("总利息", 0);
    assert.doesNotMatch(await page.locator("#root").innerText(), /[-−][¥￥]\s?0|NaN|Infinity/);
    console.log(
      `PASS ${mode}: zero-rate seven-year edge has exactly zero interest, finite payments and no negative zero`,
    );

    await start(mode, `action-disclosure-${mode}`, "disclosure");
    await button("Local action").waitFor();
    for (const name of ["Local action", "Reset action", "Copy action", "Link action"]) {
      await hint(name, false);
    }
    for (const name of [
      "Explicit follow-up",
      "Implicit follow-up",
      "Legacy follow-up",
      "Mixed follow-up",
      "Empty legacy follow-up",
    ]) {
      await hint(name, true);
    }
    await button("Local action").click();
    assert.equal((await state()).$count, 1);
    assert.equal((await snapshot()).request, null);
    await button("Reset action").click();
    assert.equal((await state()).$count, 0);
    await button("Copy action").click();
    assert.equal(await page.evaluate(() => window.localActionCopies.at(-1)), "local copy");
    await button("Link action").click();
    assert.equal((await snapshot()).tabs[0].url, "https://example.com/local-actions");
    assert.equal((await snapshot()).request, null);
    await button("Explicit follow-up").click();
    assert.match((await snapshot()).request.text, /Explain current data/);
    assert.match((await snapshot()).request.text, /"count": 0/);
    await button("Implicit follow-up").click();
    assert.equal((await snapshot()).request.text, "Implicit follow-up");
    await button("Legacy follow-up").click();
    assert.match((await snapshot()).request.text, /^Legacy follow-up/);
    assert.match((await snapshot()).request.text, /legacy context/);
    await button("Mixed follow-up").click();
    assert.equal((await state()).$count, 1);
    assert.match((await snapshot()).request.text, /Mixed request/);
    assert.match((await snapshot()).request.text, /"source": "mixed"/);
    await button("Empty legacy follow-up").click();
    assert.equal((await snapshot()).request.text, "Empty legacy follow-up");
    await page.evaluate(() => window.genUiControls.incomplete());
    await page.waitForFunction(() => document.querySelector("#root .genui_block button")?.disabled);
    for (const control of await page.locator("#root .genui_block button").all()) {
      assert.equal(await control.isDisabled(), true);
    }
    console.log(
      `PASS ${mode}: explicit, implicit, legacy and mixed follow-ups disclose editable drafts while local/copy/link actions remain distinct`,
    );
  }

  assert.deepEqual(unwantedRequests, [], "local actions must not make backend/provider requests");
  assert.deepEqual(errors, [], `uncaught browser errors: ${errors.join("; ")}`);
  console.log("GenUI local-action browser regressions passed; zero backend/model requests.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
