/** Isolated compositor regression. Never connects to the user's API or sends a message. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(desktop);
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null },
  plugins: [
    {
      name: "composer-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url !== "/composer-fixture") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await s.transformIndexHtml(
              req.url,
              '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/scripts/fixtures/composer-input.tsx"></script>',
            ),
          );
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/composer-fixture`);
  const field = page.locator("textarea").first();
  const welcome = page.getByRole("textbox", { name: "Welcome" });
  await field.waitFor();
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const metrics = async (el = field) => {
    await settle();
    return el.evaluate((e) => ({
      height: e.clientHeight,
      scroll: e.scrollTop,
      total: e.scrollHeight,
      start: e.selectionStart,
      end: e.selectionEnd,
      color: getComputedStyle(e).color,
    }));
  };
  assert.equal((await metrics()).height, 36);
  await field.fill("中文自动换行，光标应紧随文字 Mixed text 123. ".repeat(12));
  let m = await metrics();
  assert(m.height > 36 && m.height <= 160);
  assert.notEqual(m.color, "rgba(0, 0, 0, 0)");
  const lines = Array.from({ length: 35 }, (_, i) => `第${i + 1}行 caret visibility`).join("\n");
  await field.fill(lines);
  await field.press("ControlOrMeta+End");
  m = await metrics();
  assert.equal(m.height, 160);
  assert(m.scroll >= m.total - m.height - 2, JSON.stringify(m));
  await field.evaluate((e) => {
    e.setSelectionRange(4, 4);
    e.dispatchEvent(new Event("select"));
  });
  m = await metrics();
  assert.equal(m.start, 4);
  assert.equal(m.end, 4);
  assert(m.scroll < 20);
  await field.press("x");
  m = await metrics();
  assert.equal(m.start, 5);
  assert(m.scroll < 20);
  await field.fill("短文本");
  assert.equal((await metrics()).height, 36);
  await field.fill("换行\n\n");
  assert.equal((await metrics()).height, 60);
  await field.fill("宽度变化中文段落".repeat(14));
  const wide = (await metrics()).height;
  await page.setViewportSize({ width: 375, height: 800 });
  assert((await metrics()).height > wide);
  await field.fill("/test 中文命令高亮 followed by text".repeat(10));
  const backdrop = page.locator('[aria-hidden="true"]').filter({ hasText: "/test" }).first();
  await backdrop.waitFor({ state: "visible" });
  assert.equal((await field.boundingBox()).width, (await backdrop.boundingBox()).width);
  await field.dispatchEvent("compositionstart");
  assert.notEqual((await metrics()).color, "rgba(0, 0, 0, 0)");
  await field.dispatchEvent("compositionend");
  assert.equal((await metrics()).color, "rgba(0, 0, 0, 0)");
  await field.fill("");
  assert.equal((await metrics()).height, 36);
  await welcome.fill(lines);
  assert.equal((await metrics(welcome)).height, 200);
  await welcome.fill("");
  assert.equal((await metrics(welcome)).height, 72);
  await page.setViewportSize({ width: 1000, height: 800 });
  await field.fill(
    "自动增高与原生光标测试。中文、English、123。\n第二行继续编辑，文字和光标使用同一层排版。\n第三行也完整可见。",
  );
  await field.press("ControlOrMeta+End");
  await mkdir("/tmp/openhorn-composer-evidence", { recursive: true });
  await page.screenshot({ path: "/tmp/openhorn-composer-evidence/input.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS composer: growth, cap, active caret scroll, middle editing, shrink, trailing newlines, width changes, native text, slash layout, composition painting, welcome sizing (13 cases)",
  );
} finally {
  await browser?.close();
  await server.close();
}
