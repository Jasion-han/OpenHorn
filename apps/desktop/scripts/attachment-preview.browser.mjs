/** Isolated originals only: no normal app data or real backend/model calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

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
    viewport: { width: 900, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/attachments/test-auth")
      return route.fulfill({
        status: 401,
        body: "unauthorized",
        headers: {
          "Access-Control-Allow-Origin": route.request().headers().origin ?? "*",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    if (
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === String(server.httpServer.address().port)
    )
      return route.continue();
    if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/attachment-preview.html`,
  );
  const dialog = page.getByRole("dialog");
  const open = async (name) => {
    await page
      .getByRole("region", { name: "Messages", exact: true })
      .getByRole("button", { name: `查看附件: ${name}`, exact: true })
      .click();
    await dialog.waitFor();
  };
  const close = async () => {
    // A just-selected dropdown item can still own Escape during its exit animation.
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };
  await page
    .getByRole("region", { name: "Composer" })
    .getByRole("button", { name: "查看附件: notes.txt" })
    .focus();
  await page.keyboard.press("Enter");
  await dialog.locator("pre").waitFor();
  assert.equal(await dialog.locator("pre").innerText(), "FIRST\nneedle one\nneedle two\nLAST");
  await dialog.getByRole("searchbox").fill("needle");
  assert.equal(await dialog.locator("mark").innerText(), "needle");
  await dialog.getByRole("button", { name: "1 / 2", exact: true }).click();
  await dialog.getByRole("button", { name: "2 / 2", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "复制内容", exact: true }).click();
  await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "FIRST\nneedle one\nneedle two\nLAST",
  );
  await dialog.getByRole("button", { name: "更多操作", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "另存为", exact: true }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "notes.txt");
  assert.equal(
    await fs.readFile(await download.path(), "utf8"),
    "FIRST\nneedle one\nneedle two\nLAST",
  );
  await close();
  await page.getByRole("button", { name: "移除附件", exact: true }).click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.getByText("removed: 1", { exact: true }).count(), 1);
  console.log(
    "PASS composer keyboard preview, original text, search, clipboard, complete download and independent remove",
  );

  await open("README.md");
  await dialog.getByRole("heading", { name: "Heading", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "查看原文", exact: true }).click();
  assert.equal((await dialog.locator("pre").innerText()).includes("<img"), true);
  assert.equal(await page.evaluate(() => !!window.attachmentInjected), false);
  await close();
  await open("page.html");
  await dialog.locator("pre").waitFor();
  assert.equal((await dialog.locator("pre").innerText()).startsWith("<script>"), true);
  assert.equal(await page.evaluate(() => !!window.attachmentInjected), false);
  await close();
  console.log("PASS Markdown source/render and inert HTML; no remote image loading");

  for (const [name, expected] of [
    ["archive.zip", "暂不支持此格式"],
    ["empty.txt", "文件内容为空"],
    ["large.txt", "当前仅预览前 2 MB"],
    ["old.txt", "附件原文件已不可用"],
  ]) {
    await open(name);
    await dialog.getByText(expected, { exact: false }).waitFor();
    if (name === "large.txt")
      assert.equal((await dialog.locator("pre").innerText()).includes("HIDDEN-END"), false);
    await close();
  }
  await open("auth.txt");
  await dialog.getByText("当前无权读取此附件", { exact: false }).waitFor();
  await close();
  console.log("PASS unsupported, empty, bounded large-file, auth and metadata-only history states");
  await open("image.svg");
  await dialog.getByRole("img", { name: "image.svg", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "放大", exact: true }).click();
  await dialog.getByText("125%", { exact: true }).waitFor();
  await page.keyboard.press("ArrowRight");
  await dialog.getByRole("heading", { name: "second.svg", exact: true }).waitFor();
  await close();
  await open("two-pages.pdf");
  await page.waitForFunction(() => document.querySelector("canvas")?.width === 400);
  await dialog.getByRole("button", { name: "下一项", exact: true }).click();
  await dialog.getByText("2 / 2", { exact: true }).waitFor();
  await dialog.getByRole("combobox").selectOption("1.5");
  await page.waitForFunction(() => document.querySelector("canvas")?.width === 600);
  await dialog.getByRole("searchbox").fill("needle");
  await dialog.getByRole("button", { name: "命中页数: 1", exact: true }).waitFor();
  await close();
  console.log(
    "PASS image zoom/gallery keyboard navigation and PDF original rendering, page/zoom/search",
  );

  await open("audio.wav");
  await page.waitForFunction(() => document.querySelector("audio")?.duration > 0);
  assert.equal(await dialog.locator("audio").evaluate((e) => e.controls), true);
  await close();
  await open("video.mp4");
  await dialog.getByText("当前文件无法预览", { exact: false }).waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "更多操作", exact: true }).isEnabled(),
    true,
  );
  await close();
  await open("notes.txt");
  await dialog.locator("pre").waitFor();
  await page.setViewportSize({ width: 640, height: 600 });
  await page.screenshot({ path: "/tmp/openhorn-attachment-preview.png", animations: "disabled" });

  assert.equal(
    await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth),
    true,
  );
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[role="dialog"]')).backgroundColor ===
      "rgb(28, 28, 28)",
  );
  await page.screenshot({
    path: "/tmp/openhorn-attachment-preview-dark.png",
    animations: "disabled",
  });
  await close();
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = page.getByRole("complementary", { name: "预览", exact: true });
  const reader = page.getByRole("region", { name: "查看附件", exact: true });
  const sidebarOpen = async (name) => {
    await page
      .getByRole("region", { name: "Messages", exact: true })
      .getByRole("button", { name: `查看附件: ${name}`, exact: true })
      .click();
    await reader.getByRole("heading", { name, exact: true }).waitFor();
  };
  await sidebarOpen("notes.txt");
  assert.equal(await dialog.count(), 0);
  await reader.locator("pre").waitFor();
  await page
    .getByRole("textbox", { name: "Chat draft", exact: true })
    .fill("Continue chatting while reading");
  assert.equal(
    await page.getByRole("textbox", { name: "Chat draft", exact: true }).inputValue(),
    "Continue chatting while reading",
  );
  await sidebarOpen("README.md");
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.getByRole("button", { name: "README.md", exact: true }).count(), 1);
  assert.equal(await panel.getByRole("button", { name: "notes.txt", exact: true }).count(), 0);
  await reader.getByRole("button", { name: "放大查看", exact: true }).click();
  await dialog.getByRole("heading", { name: "README.md", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await reader.getByRole("heading", { name: "README.md", exact: true }).waitFor();
  const resize = panel.locator('[title="拖动调整预览面板宽度"]');
  const box = await resize.boundingBox();
  assert.ok(box);
  const before = await panel.evaluate((e) => e.getBoundingClientRect().width);
  await page.mouse.move(box.x + 2, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 150);
  await page.mouse.up();
  assert.equal((await panel.evaluate((e) => e.getBoundingClientRect().width)) > before, true);
  await panel.getByRole("button", { name: "收起预览", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Expand preview", exact: true }).click();
  await reader.getByRole("heading", { name: "README.md", exact: true }).waitFor();
  await sidebarOpen("image.svg");
  await page.getByRole("textbox", { name: "Chat draft", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await reader.getByRole("heading", { name: "image.svg", exact: true }).count(), 1);
  await page.evaluate(() => {
    window.attachmentNativeCalls = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.attachmentNativeCalls.push({ command, args });
        return null;
      },
    };
  });
  await sidebarOpen("notes.txt");
  await reader.locator("pre").waitFor();
  await reader.getByRole("button", { name: "用默认应用打开", exact: true }).click();
  await page.waitForFunction(() => window.attachmentNativeCalls.length === 1);
  const direct = await page.evaluate(() => window.attachmentNativeCalls[0]);
  assert.equal(direct.command, "open_attachment");
  assert.equal(
    new TextDecoder().decode(new Uint8Array(direct.args.bytes)),
    "FIRST\nneedle one\nneedle two\nLAST",
  );
  assert.equal(await page.getByRole("menuitem", { name: "另存为", exact: true }).count(), 0);
  await reader.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "另存为", exact: true }).click();
  await page.waitForFunction(() => window.attachmentNativeCalls.length === 2);
  assert.equal(
    await page.evaluate(() => window.attachmentNativeCalls[1].command),
    "save_attachment",
  );
  await page.evaluate(() => {
    delete window.__TAURI_INTERNALS__;
  });
  console.log("PASS direct system-open invokes no save command; optional Save As is separate");
  await sidebarOpen("old.txt");
  await reader.getByText("附件原文件已不可用", { exact: false }).waitFor();
  await page.screenshot({ path: "/tmp/openhorn-attachment-sidebar.png", animations: "disabled" });
  await page.setViewportSize({ width: 900, height: 700 });
  await dialog.getByRole("heading", { name: "old.txt", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("textbox", { name: "Chat draft", exact: true }).inputValue(),
    "Continue chatting while reading",
  );
  console.log(
    "PASS sidebar default, chat editing/keyboard isolation, single-tab replacement, expand/Escape, resize/collapse and automatic narrow fallback",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS unsupported media fallback, narrow/dark layout, no page errors or external requests",
  );
} finally {
  await browser?.close();
  await server.close();
}
