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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/attachment-scroll.html`,
  );
  await page.getByRole("button", { name: "Locate round", exact: true }).click();
  const button = page
    .locator('[data-chat-message-key="message-55"]')
    .getByRole("button", { name: "查看附件: anchor.txt", exact: true });
  await button.waitFor();
  await prepareAttachmentPosition(page, "message-55", 300);
  const offset = () =>
    button.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest("[data-chat-scroll-viewport]").getBoundingClientRect().top,
    );
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-chat-message-key="message-55"] button');
    return (
      button &&
      Math.abs(
        button.getBoundingClientRect().top -
          button.closest("[data-chat-scroll-viewport]").getBoundingClientRect().top -
          300,
      ) < 2
    );
  });
  const clickChip = async (target) => {
    const box = await target.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const original = await offset();
  await clickChip(button);
  await page.getByRole("region", { name: "查看附件", exact: true }).locator("pre").waitFor();
  await page.waitForTimeout(250);
  const opened = await offset().catch(() => Number.NaN);
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await page.waitForTimeout(250);
  const closed = await offset().catch(() => Number.NaN);
  console.log({ original, opened, closed });
  assert.ok(Math.abs(opened - original) < 3, `open drift: ${opened - original}`);
  assert.ok(Math.abs(closed - original) < 3, `close drift: ${closed - original}`);
  const viewport = page.locator("[data-chat-scroll-viewport]");
  const expectOffset = (key, expected) => waitForAttachmentPosition(page, key, expected);
  await clickChip(button);
  await expectOffset("message-55", original);
  const panel = page.getByRole("complementary", { name: "预览", exact: true });
  const resize = panel.locator('[title="拖动调整预览面板宽度"]');
  const resizeBox = await resize.boundingBox();
  assert.ok(resizeBox);
  await page.mouse.move(resizeBox.x + 2, resizeBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x - 100, resizeBox.y + 100);
  await page.mouse.up();
  await expectOffset("message-55", original);
  await page.getByRole("button", { name: "Delayed height", exact: true }).click();
  await expectOffset("message-55", original);
  const viewportBox = await viewport.boundingBox();
  assert.ok(viewportBox);
  await page.mouse.move(viewportBox.x + viewportBox.width / 2, viewportBox.y + 300);
  await page.mouse.wheel(0, 1700);
  await page.waitForFunction(() => {
    const element = document.querySelector(
      '[data-chat-message-key="message-55"] [data-chat-attachment-index]',
    );
    return element && element.getBoundingClientRect().top < -200;
  });
  // The clicked round remains mounted even when the user reads other history.
  assert.equal(await button.count(), 1);
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await expectOffset("message-55", original);
  await clickChip(button);

  await expectOffset("message-55", original);
  await panel.getByRole("button", { name: "收起预览", exact: true }).click();
  await expectOffset("message-55", original);
  await page.getByRole("button", { name: "Expand preview", exact: true }).click();
  await expectOffset("message-55", original);
  const nextButton = page.locator(
    '[data-chat-message-key="message-56"] [data-chat-attachment-index]',
  );
  await nextButton.evaluate((element) => {
    const viewport = element.closest("[data-chat-scroll-viewport]");
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 260;
  });
  await expectOffset("message-56", 260);
  await clickChip(nextButton);
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await expectOffset("message-56", 260);
  console.log(
    "PASS virtualized open/close, drag, delayed row growth, free manual scrolling, collapse/reopen and new attachment origin",
  );
  await clickChip(nextButton);
  await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-chat-scroll-viewport]").scrollTop < 2,
  );
  await page.screenshot({
    path: "/tmp/openhorn-preview-scroll-anchor.png",
    animations: "disabled",
  });
  console.log("PASS conversation switch cancels the previous attachment's return position");
  await page.getByRole("button", { name: "Locate round", exact: true }).click();
  await button.waitFor();
  await prepareAttachmentPosition(page, "message-55", 300);
  await expectOffset("message-55", 300);
  await clickChip(button);
  await expectOffset("message-55", 300);
  const beforeExplicit = await viewport.evaluate((element) => element.scrollTop);
  await page.getByRole("button", { name: "Jump latest", exact: true }).click();
  await page.waitForFunction(
    (before) => document.querySelector("[data-chat-scroll-viewport]").scrollTop > before + 1500,
    beforeExplicit,
  );
  await page.getByRole("button", { name: "关闭附件预览", exact: true }).click();
  await page.waitForFunction(() => {
    const last = document.querySelector('[data-chat-message-key="message-129"]');
    const viewport = last?.closest("[data-chat-scroll-viewport]");
    return (
      last && viewport && last.getBoundingClientRect().top < viewport.getBoundingClientRect().bottom
    );
  });
  console.log("PASS explicit new-message scroll ownership cancels the old preview anchor");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
