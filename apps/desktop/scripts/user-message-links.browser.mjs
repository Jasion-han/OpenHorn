import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  prepareAttachmentPosition,
  waitForAttachmentPosition,
} from "./helpers/attachment-scroll-assertions.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(desktop);
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: { port: 0, strictPort: false, host: "127.0.0.1", watch: null, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [],
    network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.externalLinkCalls = [];
    window.open = (...args) => {
      window.externalLinkCalls.push(args);
      return null;
    };
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    network.push(url.href);
    return route.abort();
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${base}/tests/user-message-links.html`);
  const bubble = page.getByRole("region", { name: "User bubble", exact: true });
  const first = bubble.getByRole("link", {
    name: "https://example.test/a_(b)?x=1&y=2",
    exact: true,
  });
  await first.waitFor();
  assert.equal(
    await bubble.locator("p").textContent(),
    await page.evaluate(() => window.userLinkSource),
  );
  assert.equal(await bubble.getByRole("link").count(), 3);
  assert.equal(await page.getByRole("complementary", { name: "预览", exact: true }).count(), 0);
  assert.deepEqual(network, []);
  const box = await first.boundingBox();
  assert.ok(box);
  // Start in plain text to select across the URL rather than drag a hyperlink.
  await page.mouse.move(box.x - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(100, box.width - 3), box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.getSelection().isCollapsed), false);
  await first.dispatchEvent("click", { bubbles: true, cancelable: true, detail: 1, button: 0 });
  assert.equal(await page.getByRole("complementary", { name: "预览", exact: true }).count(), 0);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await first.click();
  const panel = page.getByRole("complementary", { name: "预览", exact: true });
  await panel.waitFor();
  assert.equal(
    await panel.getByRole("textbox", { name: "输入网址", exact: true }).inputValue(),
    "https://example.test/a_(b)?x=1&y=2",
  );
  assert.equal(await page.evaluate(() => window.linkEscapedClicks), 0);
  await page
    .getByRole("textbox", { name: "Chat draft", exact: true })
    .fill("Continue while reading");
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).first().click();
  await first.click({ modifiers: ["Meta"] });
  assert.equal(await page.evaluate(() => window.externalLinkCalls.length), 1);
  assert.equal(await page.getByRole("complementary", { name: "预览", exact: true }).count(), 0);
  await first.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "https://example.test/a_(b)?x=1&y=2",
  );
  await first.click({ button: "right" });
  await page.getByRole("menuitem", { name: "在浏览器中打开", exact: true }).click();
  assert.equal(await page.evaluate(() => window.externalLinkCalls.length), 2);
  await first.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor();
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).first().click();
  await page.getByRole("button", { name: "Reload messages", exact: true }).click();
  assert.equal(await bubble.getByRole("link").count(), 3);
  assert.equal(
    await bubble.locator("p").textContent(),
    await page.evaluate(() => window.userLinkSource),
  );
  assert.equal(await bubble.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), true);
  console.log(
    "PASS actual user bubble preserves raw text/slash chip, no eager URL requests, selection-safe click, preview, browser modifier, menus, clipboard and keyboard/history rendering",
  );
  await page.screenshot({ path: "/tmp/openhorn-user-links.png", animations: "disabled" });
  await page.goto(
    `${base}/tests/attachment-scroll.html?link=${encodeURIComponent("https://example.test/source")}`,
  );
  await page.getByRole("button", { name: "Locate round", exact: true }).click();
  await prepareAttachmentPosition(page, "message-55", 300);
  const link = page.locator('[data-chat-message-key="message-55"] [data-chat-user-link-index]');
  const linkBox = await link.boundingBox();
  assert.ok(linkBox);
  await page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
  await panel.waitFor();
  assert.equal(await waitForAttachmentPosition(page, "message-55", 300), 300);
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).first().click();
  assert.equal(await waitForAttachmentPosition(page, "message-55", 300), 300);
  console.log(
    "PASS user-link web preview opens/closes at the original 300px position in a virtualized long conversation",
  );
  await page.evaluate(async () => {
    const { usePreviewPanelStore } = await import("/src/stores/previewPanelStore.ts");
    usePreviewPanelStore.getState().openUrl("https://prior.test/");
  });
  await page.getByRole("button", { name: "Locate round", exact: true }).click();
  await prepareAttachmentPosition(page, "message-55", 300);
  const nextBox = await link.boundingBox();
  assert.ok(nextBox);
  await page.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  await waitForAttachmentPosition(page, "message-55", 300);
  const viewportBox = await page.locator("[data-chat-scroll-viewport]").boundingBox();
  assert.ok(viewportBox);
  await page.mouse.move(viewportBox.x + 100, viewportBox.y + 300);
  await page.mouse.wheel(0, 1500);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-chat-message-key="message-55"] [data-chat-user-link-index]')
        .getBoundingClientRect().top < -100,
  );
  await panel
    .locator("form:visible")
    .getByRole("button", { name: "关闭标签页", exact: true })
    .click();
  await waitForAttachmentPosition(page, "message-55", 300);
  assert.equal(
    await panel.getByRole("textbox", { name: "输入网址", exact: true }).inputValue(),
    "https://prior.test/",
  );
  await panel
    .locator("form:visible")
    .getByRole("button", { name: "关闭标签页", exact: true })
    .click();
  await waitForAttachmentPosition(page, "message-55", 300);
  console.log(
    "PASS closing a user-link tab after manual scrolling returns to that link while preserving prior tabs and final panel close position",
  );
  assert.deepEqual(network, []);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
