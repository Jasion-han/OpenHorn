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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    let callback = 0;
    window.localPathCalls = [];
    window.localFileExists = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:event|unlisten") return null;
        window.localPathCalls.push({ command, args });
        if (
          args.path === "/fixture/deleted.txt" ||
          (args.path === "/fixture/notes.txt" && !window.localFileExists)
        )
          throw "not_found";
        if (command === "inspect_local_path")
          return {
            path: args.path,
            fileName: args.path.split("/").at(-1),
            kind: args.path === "/fixture/folder" ? "directory" : "file",
            size: args.path === "/fixture/large.pdf" ? 21 * 1024 * 1024 : 32,
          };
        if (command === "read_local_path")
          return Array.from(new TextEncoder().encode("FIRST\nOriginal local file 中文\nLAST"));
        if (command === "open_local_path" || command === "reveal_local_path") return null;
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/local-path-links.html`,
  );
  const file = page.getByRole("button", { name: "/fixture/notes.txt", exact: true });
  await file.waitFor();
  assert.equal(await file.count(), 1); // A fenced block and code inside an existing link stay non-nested.
  assert.equal(await page.getByRole("button", { name: "/bin/ls -la", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.localPathCalls.length), 0);
  await file.click();
  const panel = page.getByRole("complementary", { name: "预览", exact: true });
  await panel.locator("pre").waitFor();
  assert.equal(await panel.locator("pre").textContent(), "FIRST\nOriginal local file 中文\nLAST");
  await panel.getByRole("button", { name: "用默认应用打开", exact: true }).click();
  await page.waitForFunction(() =>
    window.localPathCalls.some((call) => call.command === "open_local_path"),
  );
  assert.equal(
    await page.evaluate(() =>
      window.localPathCalls.some((call) =>
        ["save_attachment", "open_attachment"].includes(call.command),
      ),
    ),
    false,
  );
  await panel.getByRole("button", { name: "在 Finder 中显示", exact: true }).click();
  await page.waitForFunction(() =>
    window.localPathCalls.some((call) => call.command === "reveal_local_path"),
  );
  await panel.getByRole("button", { name: "复制路径", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "/fixture/notes.txt");
  await page.getByRole("textbox", { name: "Chat draft", exact: true }).fill("Continue reading");
  await page.getByRole("link", { name: "Explicit code link", exact: true }).click();
  await panel.locator("pre").waitFor();
  assert.equal(await panel.locator("pre").textContent(), "FIRST\nOriginal local file 中文\nLAST");
  await page.evaluate(() => {
    window.localFileExists = false;
  });
  await file.click();
  await panel.getByText("文件或文件夹不存在", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).click();
  await page.getByRole("button", { name: "/fixture/deleted.txt", exact: true }).click();
  await panel.getByText("文件或文件夹不存在", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).click();
  await page.getByRole("button", { name: "/fixture/folder", exact: true }).click();
  await page.waitForFunction(() =>
    window.localPathCalls.some(
      (call) => call.command === "open_local_path" && call.args.path === "/fixture/folder",
    ),
  );
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() =>
      window.localPathCalls.some(
        (call) => call.command === "read_local_path" && call.args.path === "/fixture/folder",
      ),
    ),
    false,
  );
  await page.getByRole("button", { name: "/fixture/large.pdf", exact: true }).click();
  await panel.getByText("文件较大", { exact: false }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.localPathCalls.some(
        (call) => call.command === "read_local_path" && call.args.path === "/fixture/large.pdf",
      ),
    ),
    false,
  );
  await panel.getByRole("button", { name: "关闭标签页", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "/fixture/deleted.txt", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("文件或文件夹不存在", { exact: false }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate(() => {
    window.localFileExists = true;
  });
  await file.click();
  await dialog.locator("pre").waitFor();
  assert.equal(await dialog.locator("pre").textContent(), "FIRST\nOriginal local file 中文\nLAST");
  await page.screenshot({ path: "/tmp/openhorn-local-path-preview.png", animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/attachment-scroll.html?path=${encodeURIComponent("/fixture/notes.txt")}`,
  );
  await page.getByRole("button", { name: "Locate round", exact: true }).click();
  await prepareAttachmentPosition(page, "message-55", 300);
  const origin = page.locator('[data-chat-message-key="message-55"] [data-chat-local-path-id]');
  const box = await origin.boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await panel.locator("pre").waitFor();
  await waitForAttachmentPosition(page, "message-55", 300);
  await panel.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  await waitForAttachmentPosition(page, "message-55", 300);
  console.log(
    "PASS local path preview returns to its 300px origin in a virtualized long conversation",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS inline path only, original-file preview/open/reveal/copy, repeat-click revalidation, deleted file, directory, size limit and narrow dialog",
  );
} finally {
  await browser?.close();
  await server.close();
}
