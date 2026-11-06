/** Run with the directory printed by generate-attachment-fixtures.py. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  prepareAttachmentPosition,
  waitForAttachmentPosition,
} from "./helpers/attachment-scroll-assertions.mjs";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.argv[2];
const scrollOnly = process.argv.includes("--scroll-only");
if (!root) throw new Error("Fixture directory required");
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const child = spawn("bun", [path.join(desktop, "../server/scripts/attachment-matrix.ts")], {
  cwd: path.join(desktop, "../server"),
  env: { ...process.env, NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let childErrors = "";
child.stderr.on("data", (chunk) => {
  childErrors += chunk;
});
let browser, server;
const results = [];
try {
  const ready = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error(`Isolated server startup timeout: ${childErrors}`)),
      30_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Isolated server exited ${code}: ${childErrors}`));
    });
    child.stdout.on("data", (chunk) => {
      text += chunk;
      for (const line of text.split("\n")) {
        try {
          const data = JSON.parse(line);
          if (data.kind === "attachmentMatrixServer") {
            clearTimeout(timer);
            resolve(data);
            return;
          }
        } catch {}
      }
    });
  });
  for (const item of scrollOnly ? [] : manifest.files) {
    const form = new FormData();
    form.set("conversationId", ready.conversationId);
    form.set(
      "files",
      new File([await fs.readFile(path.join(root, item.name))], item.name, { type: item.mime }),
    );
    const response = await fetch(`${ready.url}/attachments/upload`, { method: "POST", body: form });
    const data = await response.json();
    item.upload = response.status;
    if (response.ok) {
      item.id = data.attachments[0].id;
      const original = await fetch(`${ready.url}/attachments/${item.id}`);
      assert.equal(original.status, 200);
      assert.equal(
        crypto
          .createHash("sha256")
          .update(new Uint8Array(await original.arrayBuffer()))
          .digest("hex"),
        item.sha256,
      );
      item.roundTrip = true;
    } else item.uploadError = data.error;
  }
  process.chdir(desktop);
  server = await createServer({
    root: desktop,
    configFile: path.join(desktop, "vite.config.ts"),
    define: { "import.meta.env.VITE_API_BASE": JSON.stringify(ready.url) },
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    plugins: [
      {
        name: "synthetic-matrix-files",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, "http://127.0.0.1");
            if (url.pathname === "/__matrix/manifest.json") {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(manifest));
              return;
            }
            if (!url.pathname.startsWith("/__matrix/file/")) return next();
            const name = decodeURIComponent(url.pathname.slice("/__matrix/file/".length));
            const item = manifest.files.find((file) => file.name === name);
            if (!item) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("Content-Type", item.mime);
            res.end(await fs.readFile(path.join(root, item.name)));
          });
        },
      },
    ],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/attachment-matrix.html`,
  );
  await page
    .getByLabel("Fixture files")
    .setInputFiles(manifest.files.map((item) => path.join(root, item.name)));
  await page.evaluate(() => {
    let callback = 0;
    window.matrixNativeCalls = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") return ++callback;
        if (command === "plugin:event|unlisten") return null;
        if (command === "open_attachment" || command === "save_attachment") {
          window.matrixNativeCalls.push({ command, args });
          return null;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    };
  });
  const reader = page.getByRole("region", { name: "查看附件", exact: true });
  const check = async (item) => {
    if (item.expected === "unsupported") {
      await reader.getByText("暂不支持此格式", { exact: false }).waitFor();
      return "file information";
    }
    if (item.expected === "error") {
      await reader.getByText("当前文件无法预览", { exact: false }).waitFor();
      return "error fallback";
    }
    if (item.kind === "text") {
      await reader.locator("pre").waitFor();
      assert.equal(await reader.locator("pre").textContent(), item.text);
      return "original text";
    }
    if (item.kind === "markdown") {
      await reader.getByRole("heading", { name: "Attachment heading", exact: true }).waitFor();
      return "rendered Markdown";
    }
    if (item.kind === "image") {
      if (item.expected === "fallback") {
        await reader.getByText("当前文件无法预览", { exact: false }).waitFor();
        return "codec fallback";
      }
      await page.waitForFunction(
        (name) => {
          const image = document.querySelector(`section[aria-label="查看附件"] img`);
          return image?.alt === name && image.naturalWidth > 0;
        },
        item.name,
        { timeout: 7000 },
      );
      return "decoded image";
    }
    if (item.kind === "pdf") {
      await page.waitForFunction(
        () =>
          document.querySelector("canvas")?.width === 400 &&
          document.querySelector("canvas")?.height === 300,
        null,
        {
          timeout: 7000,
        },
      );
      return "rendered PDF";
    }
    const media = reader.locator(item.kind === "audio" ? "audio" : "video");
    await media.waitFor();
    await media.evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await page.waitForFunction(
      (kind) => document.querySelector(kind)?.currentTime > 0.15,
      item.kind,
      { timeout: 7000 },
    );
    await media.evaluate(async (element) => {
      element.pause();
      await new Promise((resolve) => {
        element.addEventListener("seeked", resolve, { once: true });
        element.currentTime = 0.7;
      });
    });
    assert.equal(
      await media.evaluate(
        (element) => element.paused && Math.abs(element.currentTime - 0.7) < 0.05,
      ),
      true,
    );
    if (item.kind === "video")
      assert.equal(await media.evaluate((element) => element.videoWidth), 320);
    return "play/pause/seek";
  };
  for (const item of scrollOnly ? [] : manifest.files) {
    const row = {
      name: item.name,
      upload: item.upload,
      roundTrip: item.roundTrip ?? false,
      expected: item.expected,
      uploadError: item.uploadError,
      checks: [],
    };
    for (const region of ["Composer files", "Message files"]) {
      try {
        await page
          .getByRole("region", { name: region, exact: true })
          .getByRole("button", { name: `查看附件: ${item.name}`, exact: true })
          .click();
        await reader.getByRole("heading", { name: item.name, exact: true }).waitFor();
        const status = await check(item);
        await reader.getByRole("button", { name: "更多操作", exact: true }).waitFor();
        const external = reader.getByRole("button", { name: "用默认应用打开", exact: true });
        assert.equal(
          await external.count(),
          item.external ? 1 : 0,
          `system-open availability for ${item.name}`,
        );
        if (item.external) {
          const before = await page.evaluate(() => window.matrixNativeCalls.length);
          await external.click();
          await page.waitForFunction(
            (before) => window.matrixNativeCalls.length === before + 1,
            before,
          );
          const call = await page.evaluate(() => window.matrixNativeCalls.at(-1));
          assert.equal(call.command, "open_attachment");
          assert.equal(
            crypto.createHash("sha256").update(new Uint8Array(call.args.bytes)).digest("hex"),
            item.sha256,
          );
        }
        row.checks.push({ source: region, status: "pass", behavior: status });
      } catch (error) {
        row.checks.push({ source: region, status: "fail", error: String(error).slice(0, 350) });
      }
      const close = reader.getByRole("button", { name: "关闭附件预览", exact: true });
      if (await close.count()) await close.click();
    }
    results.push(row);
    console.log(
      `${row.checks.every((check) => check.status === "pass") ? "PREVIEW PASS" : "PREVIEW FAIL"} ${item.name} upload=${item.upload}`,
    );
  }
  const pickerAccept = await page.locator("[data-accept]").getAttribute("data-accept");
  const scrollCases = [];
  for (const name of [
    "utf16.txt",
    "picture.png",
    "picture.tiff",
    "document.pdf",
    "video.mp4",
    "document.docx",
  ]) {
    const item = manifest.files.find((file) => file.name === name);
    const query = new URLSearchParams({
      file: name,
      mime: item.mime,
      url: `/__matrix/file/${encodeURIComponent(name)}`,
    });
    let stage = "prepare";
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/attachment-scroll.html?${query}`,
      );
      await page.getByRole("button", { name: "Locate round", exact: true }).click();
      const chip = page.locator(
        '[data-chat-message-key="message-55"] [data-chat-attachment-index]',
      );
      await chip.waitFor();
      await prepareAttachmentPosition(page, "message-55", 300);
      const stable = () => waitForAttachmentPosition(page, "message-55", 300);
      const box = await chip.boundingBox();
      assert.ok(box);
      stage = "open";
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await reader.getByRole("heading", { name, exact: true }).waitFor();
      const opened = await stable();
      stage = "close";
      await reader.getByRole("button", { name: "关闭附件预览", exact: true }).click();
      const closed = await stable();
      scrollCases.push({ name, status: "pass", original: 300, opened, closed });
      console.log(`PASS position ${name}: 300 -> ${opened} -> ${closed}`);
    } catch (error) {
      scrollCases.push({ name, status: "fail", stage, error: String(error).slice(0, 350) });
    }
  }
  const report = {
    files: results,
    scrollCases,
    pickerAccept,
    generated: new Date().toISOString(),
    skipped: manifest.skipped,
    pageErrors: errors,
    summary: {
      files: results.length,
      checks: results.reduce((sum, row) => sum + row.checks.length, 0),
      failed: results.flatMap((row) => row.checks).filter((check) => check.status === "fail")
        .length,
      scrollChecks: scrollCases.length,
      scrollFailed: scrollCases.filter((row) => row.status === "fail").length,
      uploaded: manifest.files.filter((file) => file.upload === 201).length,
    },
  };
  await fs.writeFile(
    path.join(root, scrollOnly ? "results-scroll.json" : "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report.summary));
  if (report.summary.failed || scrollCases.some((row) => row.status === "fail") || errors.length)
    process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  child.kill("SIGTERM");
}
