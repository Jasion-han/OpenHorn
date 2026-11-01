/** Run from the repository root: node apps/desktop/scripts/genui-state.browser.mjs */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  root: desktop,
  configFile: false,
  server: { port: 0, host: "127.0.0.1", fs: { allow: [path.resolve(desktop, "../..")] } },
  optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"] },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP port");
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/tests/genui-state.html`);
  await page.waitForFunction(() => !!window.genUiStateTest);
  const stat = () => page.locator("#root").innerText();
  const change = () => page.getByRole("button", { name: "change", exact: true }).click();
  const expectValue = async (value) => {
    await page.waitForFunction(
      (expected) => document.getElementById("root").innerText.includes(`X\n${expected}`),
      value,
    );
  };

  // The first closed block is interactive even while the rest of the answer streams.
  await page.evaluate(() => window.genUiStateTest.render(undefined, true, "stream-end"));
  await change();
  await expectValue(42);
  await page.evaluate(() => window.genUiStateTest.render(undefined, false, "stream-end"));
  await expectValue(42);
  console.log("PASS stream completion preserves edits made inside the 300ms disk debounce");

  await page.evaluate(() => window.genUiStateTest.render(undefined, false, "theme"));
  await change();
  await page.evaluate(() => window.genUiStateTest.theme());
  await expectValue(42);
  console.log("PASS theme remount preserves immediate interaction state");

  await page.evaluate(() => window.genUiStateTest.render(undefined, false, "revision"));
  await change();
  await page.evaluate(() =>
    window.genUiStateTest.render(
      window.genUiStateProgram.replace("$x=1", "$x=2"),
      false,
      "revision",
    ),
  );
  await expectValue(2);
  await page.evaluate(() => window.genUiStateTest.render(undefined, false, "revision"));
  await expectValue(42);
  console.log(
    "PASS replaced programs are isolated and canceled retries restore the original revision",
  );

  await page.evaluate(() => window.genUiStateTest.startAgent());
  await change();
  await page.evaluate(() => window.genUiStateTest.finishAgent());
  await expectValue(42);
  assert.deepEqual(JSON.parse(await page.evaluate(() => window.genUiStateTest.savedAgentState())), {
    $x: 42,
  });
  console.log(
    "PASS actual Agent timeline and chat-store ID reconciliation preserve edits and disk state",
  );

  for (const [name, prefix, indent] of [
    ["blockquote", "> ", "> "],
    ["numbered list", "12. ", "    "],
    ["nested quote/list", "> - ", ">   "],
  ]) {
    const open = `${prefix}\`\`\`html-ui\n${indent}<p>safe preview</p>\n${indent}<script>window.__genuiExecuted=true</script>`;
    await page.evaluate((content) => window.genUiStateTest.renderRaw(content, true), open);
    await page.locator("iframe").waitFor();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.match(await page.locator("iframe").getAttribute("srcdoc"), /safe preview/);
    await page.evaluate(
      (content) => window.genUiStateTest.renderRaw(content, true),
      `${open}\n${indent}\`\`\``,
    );
    await page.waitForFunction(
      () => document.querySelector("iframe")?.getAttribute("sandbox") === "allow-scripts",
    );
    console.log(`PASS ${name} HTML fence stays script-free until its closing fence`);
  }
  const nestedOpenUi = '> ```openui-lang\n> root=Button("nested input",@Set($x,1))\n> $x=0';
  await page.evaluate((content) => window.genUiStateTest.renderRaw(content, true), nestedOpenUi);
  const nestedButton = page.getByRole("button", { name: "nested input", exact: true });
  await nestedButton.waitFor();
  assert.equal(await nestedButton.isDisabled(), true);
  await page.evaluate(
    (content) => window.genUiStateTest.renderRaw(content, true),
    `${nestedOpenUi}\n> \`\`\``,
  );
  await page.waitForFunction(() => !document.querySelector("#root button")?.disabled);
  console.log("PASS nested OpenUI inputs stay disabled until the closing fence");
  assert.deepEqual(errors, [], `unexpected browser errors: ${errors.join("; ")}\n${await stat()}`);
  console.log("GenUI state/Markdown browser regressions passed.");
} finally {
  await browser?.close();
  await server.close();
}
