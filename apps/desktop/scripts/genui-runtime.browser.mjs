/** Real React/OpenUI regressions. Run: node apps/desktop/scripts/genui-runtime.browser.mjs */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const output = await mkdtemp(join(tmpdir(), "openhorn-genui-runtime-"));
let server;
let browser;
try {
  await build({
    entryPoints: [join(appRoot, "scripts/fixtures/genui-runtime.tsx")],
    outdir: output,
    bundle: true,
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  server = createServer(async (request, response) => {
    if (request.url === "/genui-runtime.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(await readFile(join(output, "genui-runtime.js")));
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/genui-runtime.js"></script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  });
  const page = await browser.newPage();
  const uncaught = [];
  page.on("pageerror", (error) => uncaught.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.genUiTest);
  const render = (code, streaming = false, scope = null) =>
    page.evaluate(({ code, streaming, scope }) => window.genUiTest.render(code, streaming, scope), {
      code,
      streaming,
      scope,
    });
  const text = () => page.locator("#root").innerText();

  await render(
    'root = $mode == "a" ? Card([Text("Conditional A")]) : Card([Text("Conditional B")])\n$mode="a"',
  );
  await page.getByText("Conditional A", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("source").count(), 0);
  await render('root = @Each(["one", "two"], "item", Text(item))');
  await page.getByText("one", { exact: true }).waitFor();
  assert.match(await text(), /two/);

  await render("root =", true, "stream-completion");
  await render('root = Text("Stream recovered")', false, "stream-completion");
  await page.getByText("Stream recovered", { exact: true }).waitFor();
  await render("root =", false, "invalid-replacement");
  await page.getByTestId("source").waitFor();
  await render('root = Text("Replacement recovered")', false, "invalid-replacement");
  await page.getByText("Replacement recovered", { exact: true }).waitFor();

  const recovery =
    'root=Card([Input($periods,"Periods","number"),Stat("Payment",@Payment(1000,5,$periods))])\n$periods=0';
  await render(recovery, false, "recoverable-runtime");
  await page.getByTestId("source").waitFor();
  assert.match(await text(), /部分交互内容无法显示/);
  await page.getByRole("textbox").fill("12");
  await page.waitForFunction(() => !document.querySelector('[data-testid="source"]'));
  assert.doesNotMatch(await text(), /部分交互内容无法显示/);
  assert.match(await text(), /85/);

  await render(
    'root=Card([Text("Still useful"),Select("a",[{value:"a",label:{x:3}}])])',
    false,
    "render-error",
  );
  await page.getByTestId("source").waitFor();
  assert.match(await text(), /Still useful/);

  const rows =
    'root=Card([Button("Add",@Set($rows,@Append($rows,{k:"Ref",name:"new"}))),Text(@Count($rows))])\n$rows=[{k:"Ref",name:"one"}]';
  await render(rows, false, "literal-business-data");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("2", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("source").count(), 0);

  const slider =
    'root=Card([Slider($value,0,$max,1,"Value"),Input($max,"Max","number"),Stat("Computed",$value)])\n$value=80\n$max=100';
  await render(slider, false, "slider-bounds");
  await page.getByRole("textbox").fill("50");
  await page.waitForFunction(
    () =>
      window.genUiTest.state(
        "slider-bounds",
        'root=Card([Slider($value,0,$max,1,"Value"),Input($max,"Max","number"),Stat("Computed",$value)])\n$value=80\n$max=100',
      )?.$value === 50,
  );
  assert.equal(await page.getByRole("slider").inputValue(), "50");
  assert.match(await text(), /Computed\s*50/);
  await render(
    'root=Col([Slider($value,0,1,2,"Value"),Stat("Computed",$value)])\n$value=1',
    false,
    "slider-step",
  );
  await page.waitForFunction(() => document.querySelector('input[type="range"]')?.value === "0");
  assert.match(await text(), /Computed\s*0/);

  for (const conditional of [true, false]) {
    await render(
      conditional
        ? [
            'root=Col([Slider($amount,0,100,1,"Memory base"),',
            'Button("Show memory conflict",@Set($show,true)),',
            '$show ? Slider($amount,200,300,1,"Memory conditional") : Text("Memory valid")])',
            "$amount=50",
            "$show=false",
          ].join("\n")
        : [
            'root=Col([Slider($amount,0,100,1,"Memory base"),Slider($amount,0,$max,1,"Memory dynamic"),',
            'Button("Change memory domain",@Set($max,20))])',
            "$amount=50",
            "$max=100",
          ].join("\n"),
    );
    assert.equal(await page.getByTestId("source").count(), 0);
    await page
      .getByRole("button", {
        name: conditional ? "Show memory conflict" : "Change memory domain",
        exact: true,
      })
      .click();
    await page.getByTestId("source").waitFor();
    assert.match(await text(), /交互内容无法渲染/);
    assert.equal(await page.getByRole("slider").count(), 0);
    await render('root=Slider($amount,0,100,1,"Memory recovered")\n$amount=25');
    await page.getByRole("slider", { name: "Memory recovered" }).press("ArrowRight");
    assert.equal(await page.getByRole("slider").inputValue(), "26");
    assert.equal(await page.getByTestId("source").count(), 0);
  }

  await render(
    'root=Button("Assess",@ToAssistant("Assess these values",{amount:42,accepted:false}))',
    false,
    "followup-context",
  );
  await page.getByRole("button", { name: "Assess", exact: true }).click();
  const request = await page.evaluate(() => window.genUiTest.request());
  assert.match(request.text, /Assess these values/);
  assert.match(request.text, /"amount": 42/);
  assert.match(request.text, /"accepted": false/);
  assert.ok(request.text.length <= 2000);

  assert.deepEqual(uncaught, []);
  console.log(
    "GenUI runtime browser regressions passed (roots, stream recovery, runtime/render diagnostics, source repair, slider normalization, memory-only Slider domains, explicit follow-up context).",
  );
} finally {
  await browser?.close();
  if (server)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await rm(output, { recursive: true, force: true });
}
