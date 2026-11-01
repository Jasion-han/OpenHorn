/** Actual Chat/Agent control matrix. Run: node apps/desktop/scripts/genui-controls.browser.mjs */
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
    contents: await readFile(resolve(desktop, "scripts/fixtures/genui-controls.tsx"), "utf8"),
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
  outfile: "/genui-controls.js",
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
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/genui-controls.css"><div id="root"></div><script src="/genui-controls.js"></script>',
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.controlCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => window.controlCopies.push(text) },
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.genUiControls);
  const start = (mode, program, scope) =>
    page.evaluate(({ mode, program, scope }) => window.genUiControls.start(mode, program, scope), {
      mode,
      program,
      scope,
    });
  const state = () => page.evaluate(() => window.genUiControls.state());
  const diskState = () => page.evaluate(() => window.genUiControls.state(true));
  const snapshot = () => page.evaluate(() => window.genUiControls.snapshot());
  const text = () => page.locator("#root").innerText();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const input = (name) => page.getByRole("textbox", { name, exact: true });

  assert.equal(await page.evaluate(() => window.genUiControls.inventory.length), 22);
  assert.deepEqual(await page.evaluate(() => window.genUiControls.actions), ["CopyToClipboard"]);
  for (const mode of ["chat", "agent"]) {
    await start(
      mode,
      [
        'root=Col([Chart("bar",["Low","High"],[{name:"Extreme bars",values:[-1e308,1e308]}]),',
        'Chart("line",["Zero","Tiny"],[{name:"Tiny line",values:[0,5e-324]}]),',
        'Chart("pie",["First half","Second half"],[{name:"Huge pie",values:[1e308,1e308]}])])',
      ].join("\n"),
      `chart-extremes-${mode}`,
    );
    await page.getByRole("img", { name: "Extreme bars", exact: true }).waitFor();
    assert.doesNotMatch(
      await page
        .locator('#root svg[role="img"]')
        .evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join("")),
      /NaN|Infinity/,
    );
    const points = await page
      .getByRole("img", { name: "Tiny line", exact: true })
      .locator("polyline")
      .getAttribute("points");
    assert.equal(new Set(points.split(" ").map((point) => point.split(",")[1])).size, 2);
    const pie = page.getByRole("img", { name: "First half, Second half", exact: true });
    assert.equal(await pie.locator("path title").filter({ hasText: "50%" }).count(), 2);
    console.log(`PASS ${mode}: finite extreme/tiny chart axes and overflow-safe pie percentages`);
  }
  assert.deepEqual(await page.evaluate(() => window.genUiControls.denseChart(200000)), {
    ok: true,
  });
  for (const mode of ["chat", "agent"]) {
    await start(
      mode,
      [
        'root=Col([Slider($amount,$limits.min,$limits.max,$limits.step,"Native range"),Input($amount,"Native amount","number"),',
        'Button("Change native bounds",@Set($limits,{min:0,max:1,step:0.001})),',
        'Button("Change native step",@Set($limits,{min:0,max:1,step:0.1}))])',
        "$amount=9e307",
        "$limits={min:-1e308,max:1e308,step:3e307}",
      ].join("\n"),
      `native-range-${mode}`,
    );
    const range = page.getByRole("slider", { name: "Native range", exact: true });
    const agree = async (expected) => {
      await page.waitForFunction(
        (value) => window.genUiControls.state()?.$amount === value,
        expected,
      );
      assert.equal(await range.evaluate((node) => node.valueAsNumber), expected);
      assert.equal(Number(await input("Native amount").inputValue()), expected);
      assert.equal(await range.evaluate((node) => node.validity.valid), true);
      assert.equal(
        Number((await range.getAttribute("aria-valuetext")).replace(/,/g, "")),
        expected,
      );
    };
    await agree(8e307);
    await page.evaluate(() => window.genUiControls.incomplete());
    await page.waitForFunction(() => document.querySelector('#root input[type="range"]')?.disabled);
    // A disabled preview may display the native sanitized position, but must
    // not publish it into the streaming program's still-changing declaration.
    assert.equal(Number(await input("Native amount").inputValue()), 9e307);
    assert.equal((await state()).$amount, 8e307);
    await page.evaluate(() => window.genUiControls.stop());
    await page.evaluate(() => window.genUiControls.remount());
    assert.equal(await range.isDisabled(), true);
    assert.equal(Number(await input("Native amount").inputValue()), 9e307);
    await page.evaluate(() => window.genUiControls.finish());
    await page.waitForFunction(
      () => !document.querySelector('#root input[type="range"]')?.disabled,
    );
    await agree(8e307);
    await button("Change native bounds").click();
    await agree(1);
    await input("Native amount").fill("0.12345");
    assert.equal(await input("Native amount").inputValue(), "0.12345");
    await input("Native amount").press("Tab");
    await agree(0.123);
    await button("Change native step").click();
    await agree(0.1);
    await range.focus();
    await range.press("ArrowRight");
    await agree(0.2);
    await page.evaluate(() => {
      window.genUiControls.reconcile();
      window.genUiControls.remount();
    });
    await agree(0.2);

    await start(
      mode,
      'root=Col([Slider($amount,0,1,5e-324,"Native range"),Input($amount,"Native amount","number")])\n$amount=0.5',
      `native-step-overflow-${mode}`,
    );
    await input("Native amount").fill("0.12345678901234566");
    // The browser's supported precision is authoritative, including a step
    // count that overflows JavaScript arithmetic. Do not duplicate its rounding.
    const canonical = await range.evaluate((node) => node.valueAsNumber);
    await input("Native amount").press("Tab");
    await agree(canonical);

    await start(
      mode,
      'root=Slider($amount,0,1,0.001,"Precise rate","%")\n$amount=0.001',
      `precise-readout-${mode}`,
    );
    const precise = page.getByRole("slider", { name: "Precise rate", exact: true });
    assert.equal(await precise.getAttribute("aria-valuetext"), "0.001%");
    await precise.focus();
    await precise.press("ArrowRight");
    assert.equal((await state()).$amount, 0.002);
    assert.equal(await precise.getAttribute("aria-valuetext"), "0.002%");
    assert.equal(await page.locator("#root output").innerText(), "0.002%");
    console.log(
      `PASS ${mode}: native slider value/state agreement across overflow, changing constraints, keyboard, remount and precise accessible readouts`,
    );
  }
  // Normalization of this input's own publication preserves its draft; later
  // external interactions must still replace it.
  for (const mode of ["chat", "agent"]) {
    await start(
      mode,
      [
        'root=Col([Slider($amount,0,$limit,1,"First shared range"),Slider($amount,0,$limit,1,"Second shared range"),',
        'Input($amount,"Shared domain amount","number"),Button("Narrow both ranges",@Set($limit,10))])',
        "$amount=20",
        "$limit=100",
      ].join("\n"),
      `shared-domain-${mode}`,
    );
    await input("Shared domain amount").fill("25.4");
    assert.equal(await input("Shared domain amount").inputValue(), "25.4");
    assert.equal((await state()).$amount, 25);
    assert.equal(await page.getByRole("slider", { name: "First shared range" }).inputValue(), "25");
    assert.equal(
      await page.getByRole("slider", { name: "Second shared range" }).inputValue(),
      "25",
    );
    await button("Narrow both ranges").click();
    assert.equal((await state()).$amount, 10);
    assert.equal(await page.getByRole("slider", { name: "First shared range" }).inputValue(), "10");
    assert.equal(
      await page.getByRole("slider", { name: "Second shared range" }).inputValue(),
      "10",
    );
    await page.getByRole("slider", { name: "Second shared range" }).press("ArrowLeft");
    assert.equal((await state()).$amount, 9);
    assert.equal(await input("Shared domain amount").inputValue(), "9");
    assert.doesNotMatch(await text(), /部分交互内容无法显示|交互内容无法显示/);

    for (const second of [
      'Slider($amount,200,300,1,"Different range label")',
      'Slider($amount,0,100,2,"Different step label")',
    ]) {
      await start(
        mode,
        `root=Col([Slider($amount,0,100,1,"Initial range label"),${second}])\n$amount=50`,
        `conflicting-domain-${mode}-${second.includes("200") ? "bounds" : "step"}`,
      );
      await page.getByText("交互内容无法渲染，以下为源代码", { exact: true }).waitFor();
      assert.equal(await page.getByRole("slider").count(), 0);
      assert.equal(await state(), undefined);
      assert.equal(await diskState(), undefined);
    }

    await start(
      mode,
      [
        'root=Col([Slider($amount,0,100,1,"Existing domain"),Input($amount,"Conditional amount","number"),',
        'Button("Show conflicting slider",@Set($show,true)),',
        '$show ? Slider($amount,200,300,1,"Conditional other label") : Text("One domain")])',
        "$amount=50",
        "$show=false",
      ].join("\n"),
      `conditional-conflict-${mode}`,
    );
    await input("Conditional amount").fill("60");
    const goodConditional = await state();
    assert.equal(goodConditional.$amount, 60);
    assert.equal(goodConditional.$show, false);
    await button("Show conflicting slider").click();
    await page.getByText("交互内容无法渲染，以下为源代码", { exact: true }).waitFor();
    assert.equal(await page.getByRole("slider").count(), 0);
    assert.deepEqual(await state(), goodConditional);
    assert.deepEqual(await diskState(), goodConditional);
    await page.evaluate(() => window.genUiControls.remount());
    assert.equal(await input("Conditional amount").inputValue(), "60");
    assert.equal(await page.getByRole("slider").count(), 1);
    assert.deepEqual(await state(), goodConditional);

    await start(
      mode,
      [
        'root=Col([Slider($amount,0,100,1,"Fixed domain"),Slider($amount,0,$limit,1,"Changing domain"),',
        'Input($amount,"Changing domain amount","number"),Button("Conflict one range",@Set($limit,50))])',
        "$amount=80",
        "$limit=100",
      ].join("\n"),
      `dynamic-domain-conflict-${mode}`,
    );
    await input("Changing domain amount").fill("81");
    const goodDynamic = await state();
    assert.equal(goodDynamic.$amount, 81);
    assert.equal(goodDynamic.$limit, 100);
    await button("Conflict one range").click();
    await page.getByText("交互内容无法渲染，以下为源代码", { exact: true }).waitFor();
    assert.deepEqual(await state(), goodDynamic);
    assert.deepEqual(await diskState(), goodDynamic);
    await page.evaluate(() =>
      window.genUiControls.replaceProgram(
        'root=Col([Slider($amount,0,100,1,"Recovered first"),Slider($amount,0,100,1,"Recovered second"),Input($amount,"Recovered amount","number")])\n$amount=20',
      ),
    );
    await input("Recovered amount").fill("31");
    assert.equal((await state()).$amount, 31);
    assert.equal(await page.getByRole("slider", { name: "Recovered first" }).inputValue(), "31");
    assert.equal(await page.getByRole("slider", { name: "Recovered second" }).inputValue(), "31");
    assert.doesNotMatch(await text(), /部分交互内容无法显示|交互内容无法显示/);
    console.log(
      `PASS ${mode}: shared Slider domain commits, conflict rejection before state writes, conditional/dynamic fallback, valid snapshot and program recovery`,
    );
  }

  for (const mode of ["chat", "agent"]) {
    await start(
      mode,
      'root=Card([Input($value,"Shared amount","number"),Slider($value,0,100,1,"Bound range"),Stat("Result",$value)])\n$value=10',
      `shared-number-${mode}`,
    );
    await input("Shared amount").fill("150");
    await page.waitForFunction(() => window.genUiControls.state()?.$value === 100);
    assert.equal(await input("Shared amount").inputValue(), "150");
    assert.equal(
      await page.getByRole("slider", { name: "Bound range", exact: true }).inputValue(),
      "100",
    );
    await input("Shared amount").press("Tab");
    assert.equal(await input("Shared amount").inputValue(), "100");
    await input("Shared amount").fill("1.");
    assert.equal(await input("Shared amount").inputValue(), "1.");
    await input("Shared amount").fill("-");
    assert.equal((await state()).$value, 1);
    assert.equal(await input("Shared amount").inputValue(), "-");
    await input("Shared amount").press("Tab");
    assert.equal(await input("Shared amount").inputValue(), "1");
    console.log(`PASS ${mode}: live bound-value normalization preserves an owned draft until blur`);
  }

  for (const mode of ["chat", "agent"]) {
    for (const inputFirst of [true, false]) {
      const editor = 'Input($amount,"Typing amount","number")';
      const slider = 'Slider($amount,0,$max,0.001,"Typing range")';
      await start(
        mode,
        [
          `root=Col([${inputFirst ? editor : slider},${inputFirst ? slider : editor},`,
          'Input($amount,"Other amount","number"),Stat("Live amount",$amount),',
          'Button("Set typed amount",@Set($amount,0.456)),Button("Reset typed amount",@Reset($amount)),',
          'Button("Narrow typed bounds",@Set($max,0.1))])',
          "$amount=1",
          "$max=1",
        ].join("\n"),
        `typing-source-${mode}-${inputFirst}`,
      );
      const editorInput = input("Typing amount");
      const range = page.getByRole("slider", { name: "Typing range", exact: true });
      const typeDraft = async () => {
        await editorInput.evaluate((node) => node.select());
        await editorInput.pressSequentially("0.12345");
        assert.equal(await editorInput.inputValue(), "0.12345");
        assert.equal((await state()).$amount, 0.123);
        assert.equal(await range.inputValue(), "0.123");
        assert.equal(await input("Other amount").inputValue(), "0.123");
      };
      await typeDraft();
      await editorInput.press("Tab");
      assert.equal(await editorInput.inputValue(), "0.123");
      await editorInput.fill("0.12345");
      assert.equal(await editorInput.inputValue(), "0.12345");
      assert.equal((await state()).$amount, 0.123);
      // Programmatic parent clicks keep input focus, proving that actual
      // external writes (rather than blur alone) invalidate the old draft.
      await button("Set typed amount").evaluate((node) => node.click());
      assert.equal(await editorInput.inputValue(), "0.456");
      await typeDraft();
      await button("Reset typed amount").evaluate((node) => node.click());
      assert.equal(await editorInput.inputValue(), "1");
      await typeDraft();
      await button("Narrow typed bounds").evaluate((node) => node.click());
      assert.equal(await editorInput.inputValue(), "0.1");
      assert.equal((await state()).$amount, 0.1);
      await range.focus();
      await range.press("ArrowLeft");
      assert.equal(await editorInput.inputValue(), "0.099");
      assert.equal((await state()).$amount, 0.099);
      console.log(
        `PASS ${mode} ${inputFirst ? "Input first" : "Slider first"}: real typing/fill keep draft, live canonical values and external action/reset/constraints/keyboard replace it`,
      );
    }
  }

  for (const mode of ["chat", "agent"]) {
    await start(
      mode,
      [
        'root=Col([Input($value,"Draft","number"),Input($other,"Other"),',
        'Button("External set",@Set($value,42)),Button("External reset",@Reset($value)),',
        'Input($value,"Changing type",$kind),Button("Text mode",@Set($kind,"text")),Button("Number mode",@Set($kind,"number"))])',
        "$value=10",
        '$other="Text"',
        '$kind="number"',
      ].join("\n"),
      `draft-actions-${mode}`,
    );
    await input("Draft").fill("1.");
    await button("External set").evaluate((node) => node.click());
    assert.equal(await input("Draft").inputValue(), "42");
    await input("Draft").fill("-");
    await button("External reset").evaluate((node) => node.click());
    assert.equal(await input("Draft").inputValue(), "10");
    // A real reset click blurs even when it restores the same underlying value.
    await input("Draft").fill("-");
    await button("External reset").click();
    assert.equal(await input("Draft").inputValue(), "10");
    await input("Changing type").fill("1.");
    await button("Text mode").evaluate((node) => node.click());
    assert.equal(await input("Changing type").inputValue(), "1");
    await button("Number mode").evaluate((node) => node.click());
    assert.equal(await input("Changing type").inputValue(), "1");
    await input("Draft").fill("");
    assert.equal((await state()).$value, "");
    assert.equal(await input("Changing type").inputValue(), "");
    await input("Draft").press("Tab");
    assert.equal(await input("Draft").inputValue(), "");
    await page.evaluate(() => window.genUiControls.remount());
    assert.equal(await input("Draft").inputValue(), "");
    assert.equal(await input("Changing type").inputValue(), "");
    await button("External reset").click();
    assert.equal((await state()).$value, 10);
    assert.equal(await input("Draft").inputValue(), "10");
    // The library's reactive setter reserves $value internally. Clearing a
    // differently named binding must not inherit that reserved variable.
    await start(
      mode,
      'root=Col([Input($amount,"Clear amount","number"),Input($amount,"Shared clear","number")])\n$amount=7',
      `blank-${mode}`,
    );
    await input("Clear amount").fill("");
    assert.equal((await state()).$amount, "");
    assert.equal(await input("Shared clear").inputValue(), "");
    await page.evaluate(() => window.genUiControls.remount());
    assert.equal(await input("Clear amount").inputValue(), "");
    console.log(
      `PASS ${mode}: focused external set/reset, native blur, type changes and blank numeric values`,
    );
  }

  for (const mode of ["chat", "agent"]) {
    for (const control of ["Select", "SegmentedControl"]) {
      const program = [
        `root=Col([${control}($selected,$options,"Dynamic"),Stat("Selected",$selected),`,
        'Button("Reorder",@Set($options,[{value:"Beta",label:"Renamed Beta"},"Alpha",{value:"",label:"None"}])),',
        'Button("Remove selection",@Set($options,["Gamma"])),Button("Empty options",@Set($options,[])),',
        'Button("Restore options",@Reset($options)),Button("Reset selection",@Reset($selected))])',
        '$selected="Beta"',
        '$options=["Alpha","Beta"]',
      ].join("\n");
      await start(mode, program, `dynamic-${control}-${mode}`);
      await button("Reorder").click();
      assert.equal((await state()).$selected, "Beta");
      if (control === "Select") {
        const select = page.getByRole("combobox", { name: "Dynamic", exact: true });
        assert.equal(await select.inputValue(), "Beta");
        await select.selectOption("");
        assert.equal(await select.locator('option[value=""]').isDisabled(), false);
        await select.selectOption("Beta");
      } else {
        assert.equal(await button("Renamed Beta").getAttribute("aria-pressed"), "true");
        await button("None").click();
        assert.equal((await state()).$selected, "");
        assert.equal(await button("None").getAttribute("aria-pressed"), "true");
        await button("Renamed Beta").click();
      }
      await button("Remove selection").click();
      await page.waitForFunction(() => window.genUiControls.state()?.$selected === "");
      if (control === "Select") {
        assert.equal(
          await page.getByRole("combobox", { name: "Dynamic", exact: true }).inputValue(),
          "",
        );
      } else {
        assert.equal(await button("Gamma").getAttribute("aria-pressed"), "false");
      }
      await button("Empty options").click();
      assert.equal((await state()).$selected, "");
      await button("Restore options").click();
      assert.equal((await state()).$selected, "");
      await button("Reset selection").click();
      assert.equal((await state()).$selected, "Beta");
      console.log(
        `PASS ${mode} ${control}: reorder/rename, explicit empty value, removed/empty/restored options and reset`,
      );
    }
  }

  for (const mode of ["chat", "agent"]) {
    const variants = [
      ...["sm", "md", "lg", "xl"].map(
        (size) => `Title(${JSON.stringify(`Title ${size}`)},${JSON.stringify(size)})`,
      ),
      ...["xs", "sm", "md"].map(
        (size, index) =>
          `Text(${JSON.stringify(`Text ${size}`)},${JSON.stringify(size)},"default",${JSON.stringify(["normal", "medium", "semibold"][index])},true)`,
      ),
      ...["default", "muted", "info", "success", "warning", "danger"].map(
        (tone) => `Badge(${JSON.stringify(tone)},${JSON.stringify(tone)})`,
      ),
      ...["sm", "md", "lg"].map((size) => `Icon("circle-check",${JSON.stringify(size)})`),
      'Icon("unknown-icon")',
      'Card([Text("Outline card")],"outline")',
      'Grid([Text("Clamped columns")],10)',
      'Table(["Item","Amount"],[["One",12],["Two","¥1,200"],["Missing",null],["Short"]])',
      'Chart("bar",["First","Second"],[{name:"Missing values",values:[10]}],"元",1000)',
      'Chart("line",["First","Second"],[{name:"Extra values",values:[0,0,999]}],"%",20)',
      'Chart("pie",["Only positive","Negative","Zero"],[{name:"Single slice",values:[2,-3,0]}])',
      'Chart("bar",[],[{name:"Empty labels",values:[]}])',
      'Chart("line",["Empty series"],[])',
      'Chart("pie",["Zero","Negative"],[{name:"No positive",values:[0,-1]}])',
      'Progress(-1,100,"Below zero")',
      'Progress(200,100,"Above max")',
      'Progress(50,1e308*2,"Overflow max")',
      'Progress(1e308*2,100,"Overflow value")',
      'Progress(5e-324,1e308,"Tiny current")',
    ];
    await start(mode, `root=Col([${variants.join(",")}])`, `variants-${mode}`);
    assert.equal(await page.getByRole("heading").count(), 4);
    assert.equal(await page.locator("#root .genui_badge").count(), 6);
    assert.equal(await page.locator("#root .genui_block svg[aria-hidden]").count(), 3);
    assert.equal(
      await page.locator("#root .genui_grid").evaluate((node) => node.style.gridTemplateColumns),
      "repeat(6, minmax(0px, 1fr))",
    );
    assert.equal(
      await page
        .getByRole("columnheader", { name: "Amount", exact: true })
        .evaluate((node) => getComputedStyle(node).textAlign),
      "right",
    );
    assert.equal(await page.getByRole("table").locator("tbody tr").count(), 4);
    const bar = page.getByRole("img", { name: "Missing values", exact: true });
    assert.equal(await bar.getAttribute("viewBox"), "0 0 600 480");
    assert.equal(await bar.locator("rect").count(), 2);
    assert.match(await bar.locator("rect title").last().textContent(), /Second.*0元/);
    const line = page.getByRole("img", { name: "Extra values", exact: true });
    assert.equal(await line.getAttribute("viewBox"), "0 0 600 220");
    assert.equal(await line.locator("circle").count(), 2);
    const pie = page.getByRole("img", { name: "Only positive, Negative, Zero", exact: true });
    assert.equal(await pie.locator("path").count(), 1);
    assert.match(await pie.locator("path title").textContent(), /100%/);
    assert.equal(await page.locator('#root svg[role="img"]').count(), 3);
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Below zero", exact: true })
        .getAttribute("aria-valuenow"),
      "0",
    );
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Above max", exact: true })
        .getAttribute("aria-valuenow"),
      "100",
    );
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Overflow max", exact: true })
        .getAttribute("aria-valuemax"),
      "100",
    );
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Overflow max", exact: true })
        .getAttribute("aria-valuenow"),
      "50",
    );
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Overflow value", exact: true })
        .getAttribute("aria-valuenow"),
      "0",
    );
    assert.equal(
      await page
        .getByRole("progressbar", { name: "Tiny current", exact: true })
        .getAttribute("aria-valuenow"),
      "5e-324",
    );
    assert.doesNotMatch(await text(), /部分交互内容无法显示|交互内容无法显示/);
    console.log(
      `PASS ${mode}: presentation enums, table alignment/ragged cells, chart shapes/missing/empty/zero data and progress bounds`,
    );
  }

  for (const mode of ["chat", "agent"]) {
    await start(mode, undefined, `catalog-${mode}`);
    await input("Amount").waitFor();
    assert.match(await text(), /Control catalog/);
    assert.equal(await page.getByRole("table").count(), 1);
    assert.equal(await page.locator("#root ol li").count(), 2);
    assert.equal(await page.locator("#root ul li").count(), 2);
    assert.equal(await page.locator('#root svg[role="img"]').count(), 3);
    assert.equal(await page.locator("#root table tbody tr").count(), 2);
    assert.equal(await page.getByRole("group", { name: "View", exact: true }).count(), 1);
    assert.equal(await button("Summary").getAttribute("aria-pressed"), "true");
    const progress = page.getByRole("progressbar", { name: "Progress", exact: true });
    assert.equal(await progress.getAttribute("aria-valuenow"), "5");
    assert.equal(
      await page.getByRole("heading", { name: "Control catalog", exact: true }).count(),
      1,
    );
    assert.equal(await page.getByText("Footnote", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Nested", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Good", { exact: true }).count(), 1);
    assert.equal(await page.locator("#root .genui_divider").count(), 1);
    assert.equal(await page.locator("#root .genui_spacer").count(), 1);
    assert.equal(
      await page.locator("#root .genui_grid").evaluate((node) => getComputedStyle(node).display),
      "grid",
    );
    assert.equal(await page.locator("#root .genui_cardSoft").count(), 1);
    assert.equal(await button("Disabled").isDisabled(), true);

    await input("Text").fill("Edited");
    await input("Amount").fill("1,234.50");
    assert.equal((await state()).$amount, 1234.5);
    assert.equal(await input("Amount").inputValue(), "1,234.50");
    await input("Amount").press("Tab");
    assert.equal(await input("Amount").inputValue(), "1234.5");
    const range = page.getByRole("slider", { name: "Range", exact: true });
    await range.focus();
    await range.press("ArrowRight");
    assert.equal((await state()).$range, 5.5);
    assert.equal(await progress.getAttribute("aria-valuenow"), "5.5");
    await page.getByRole("combobox", { name: "Choice", exact: true }).selectOption("Beta");
    await button("Details").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("checkbox", { name: "Accepted", exact: true }).focus();
    await page.keyboard.press("Space");
    assert.match(await text(), /Detailed view/);
    assert.equal(await button("Details").getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(await state()).filter(([name]) =>
          ["$text", "$selected", "$view", "$checked"].includes(name),
        ),
      ),
      { $text: "Edited", $selected: "Beta", $view: "Details", $checked: true },
    );
    await button("Follow up").click();
    assert.match((await snapshot()).request.text, /Explain values/);
    assert.match((await snapshot()).request.text, /"amount": 1234.5/);
    assert.match((await snapshot()).request.text, /"accepted": true/);
    await button("Copy").click();
    assert.equal(await page.evaluate(() => window.controlCopies.at(-1)), "Edited:Beta");
    await button("Link").click();
    assert.equal((await snapshot()).tabs[0].url, "https://example.com/catalog");
    await button("Offer label").click();
    assert.equal((await snapshot()).request.text, "Offer label");

    const edited = await state();
    await page.evaluate(() => {
      window.genUiControls.reconcile();
      window.genUiControls.remount();
    });
    await page.evaluate(() => window.genUiControls.reload());
    assert.deepEqual(await state(), edited);
    assert.equal(await input("Amount").inputValue(), "1234.5");
    assert.equal(
      await page.getByRole("checkbox", { name: "Accepted", exact: true }).isChecked(),
      true,
    );

    await page.evaluate(() => window.genUiControls.incomplete());
    await page.waitForFunction(() => document.querySelector('#root input[type="text"]')?.disabled);
    for (const control of await page.locator("#root input, #root select").all()) {
      assert.equal(await control.isDisabled(), true);
    }
    for (const name of [
      "Set amount",
      "Reset",
      "Disabled",
      "Follow up",
      "Copy",
      "Link",
      "Offer label",
      "Summary",
      "Details",
    ]) {
      assert.equal(await button(name).isDisabled(), true);
    }
    await page.evaluate(() => window.genUiControls.stop());
    await input("Amount").waitFor();
    assert.equal(await input("Amount").isDisabled(), true);
    await page.evaluate(() => window.genUiControls.finish());
    assert.equal(await input("Amount").isDisabled(), false);
    assert.deepEqual(await state(), edited);
    await button("Set amount").click();
    assert.equal(await input("Amount").inputValue(), "42");
    await button("Reset").click();
    assert.equal(await input("Amount").inputValue(), "10");
    assert.equal(await input("Text").inputValue(), "Initial");
    assert.equal(await button("Summary").getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.getByRole("checkbox", { name: "Accepted", exact: true }).isChecked(),
      false,
    );
    assert.doesNotMatch(await text(), /部分交互内容无法显示|交互内容无法显示/);
    console.log(
      `PASS ${mode}: all 22 components, controls/keyboard/actions, ID/remount/reload and streaming/stop/reset`,
    );
  }

  assert.deepEqual(errors, [], `uncaught browser errors: ${errors.join("; ")}`);
  console.log("GenUI control matrix browser regressions passed.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
