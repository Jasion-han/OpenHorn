import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const evidence = process.env.OPENHORN_DOCUMENT_EVIDENCE;
if (!evidence) throw new Error("Set OPENHORN_DOCUMENT_EVIDENCE to an owned scratch directory");
await mkdir(evidence, { recursive: true });
// A valid two-page PDF: text + vector bars, then an image-like graphics-only page.
function pdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "BT /F1 18 Tf 30 350 Td (Revenue Q1: 10 Q2: 20) Tj ET 0.1 0.4 0.9 rg 40 40 80 100 re f 160 40 80 200 re f",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 6 0 R >>",
    "0.9 0.3 0.1 rg 30 30 110 150 re f 0.1 0.6 0.3 rg 180 30 110 270 re f",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    const content =
      index === 3 || index === 5
        ? `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`
        : value;
    text += `${index + 1} 0 obj\n${content}\nendobj\n`;
  }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(text);
}
const sample = pdf();
await writeFile(path.join(evidence, "synthetic-charts.pdf"), sample);
const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false },
});
let browser;
const checks = [],
  errors = [],
  network = [];
const pass = (value) => {
  checks.push(value);
  console.log(`PASS ${value}`);
};
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["blob:", "data:"].includes(url.protocol)) return route.continue();
    network.push(url.origin + url.pathname);
    return route.abort();
  });
  await page.goto(`${origin}/tests/document-research.html`);
  await page.getByRole("button", { name: "Mode", exact: true }).click();
  const research = page.getByRole("button", { name: "深度研究", exact: true });
  await research.hover();
  const color = await research.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(color, "rgb(0, 0, 0)");
  await research.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.notEqual(await research.evaluate((node) => getComputedStyle(node).boxShadow), "none");
  await page.screenshot({ path: path.join(evidence, "01-research-menu-focus.png") });
  await research.click();
  assert.equal(await page.locator("textarea").inputValue(), "/research Compare the charts");
  pass("research menu keeps the question and exposes a light keyboard-focus state");
  await page.getByRole("button", { name: "Mode", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  assert.equal(await page.locator("textarea").inputValue(), "Compare the charts");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "synthetic-charts.pdf", mimeType: "application/pdf", buffer: sample });
  await page.getByRole("checkbox", { name: /读取 PDF 图表/ }).check();
  await page.getByRole("textbox", { name: "图表页码", exact: true }).fill("2");
  await page.screenshot({ path: path.join(evidence, "02-selected-document-page.png") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="result"]')?.textContent);
  const parts = await page.evaluate(() => window.documentResearch.parts());
  assert.equal(parts.filter((part) => part.kind === "image").length, 1);
  const image = parts.find((part) => part.kind === "image");
  assert.equal(image.fileName, "synthetic-charts.pdf [page 2].jpg");
  assert.ok(image.dataBase64.startsWith("/9j/"));
  assert.ok(parts.some((part) => part.kind === "file" && part.text.includes("Revenue Q1")));
  const pixels = await page.evaluate(async (data) => {
    const response = await fetch(`data:image/jpeg;base64,${data}`);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if (
        Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) >
        80
      )
        colored++;
    return colored;
  }, image.dataBase64);
  assert.ok(pixels > 1000, "actual rendered graphics, not a blank image or text placeholder");
  pass(
    "real PDF.js keeps page text and transmits the selected graphics-only page as actual JPEG bytes",
  );
  const key = await page.getByTestId("result").textContent();
  await page.reload();
  const recovered = await page.evaluate((key) => window.documentResearch.recover(key), key);
  assert.deepEqual(recovered, parts);
  const foreign = await page.evaluate(async (key) => {
    try {
      await window.documentResearch.recover(key, "different-account");
      return false;
    } catch {
      return true;
    }
  }, key);
  assert.equal(foreign, true);
  pass(
    "IndexedDB restores exact image/text inputs across reload and rejects a different account scope",
  );
  const capacity = await page.evaluate(async () => {
    const image = "A".repeat(Math.ceil((1024 * 1024) / 3) * 4);
    const parts = Array.from({ length: 6 }, (_, i) => ({
      kind: "image",
      fileName: `synthetic.pdf [page ${i + 1}].jpg`,
      mediaType: "image/jpeg",
      dataBase64: image,
    }));
    parts.push({
      kind: "file",
      fileName: "synthetic.pdf",
      mediaType: "application/pdf",
      text: "Original extracted text ".repeat(10_000),
    });
    const key = await window.documentResearch.save(parts);
    return { key, count: (await window.documentResearch.recover(key)).length };
  });
  assert.equal(capacity.count, 7);
  pass("six maximum-size page images plus extracted text fit the recovery snapshot budget");
  const retention = await page.evaluate(async () => {
    const opened = indexedDB.open("openhorn-document-input", 1);
    const db = await new Promise((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    const parts = [
      { kind: "file", fileName: "test.pdf", mediaType: "application/pdf", text: "Text" },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(parts)).length;
    const expiredKey = crypto.randomUUID(),
      foreignKey = crypto.randomUUID(),
      expiredOwnKey = crypto.randomUUID();
    const tx = db.transaction("snapshots", "readwrite"),
      table = tx.objectStore("snapshots");
    const write = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    const expired = Date.now() - 8 * 24 * 60 * 60 * 1000;
    table.put({ key: expiredKey, scope: "expired-owner", createdAt: expired, parts, bytes });
    table.put({ key: foreignKey, scope: "different-owner", createdAt: Date.now(), parts, bytes });
    table.put({
      key: expiredOwnKey,
      scope: window.documentResearch.owner,
      createdAt: expired,
      parts,
      bytes,
    });
    await write;
    let expiredReadRejected = false;
    try {
      await window.documentResearch.recover(expiredOwnKey);
    } catch {
      expiredReadRejected = true;
    }
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = () => {
      throw new Error("Full snapshot materialization is forbidden");
    };
    try {
      await window.documentResearch.save(parts);
    } finally {
      IDBObjectStore.prototype.getAll = getAll;
    }
    const inspect = db.transaction("snapshots", "readonly").objectStore("snapshots");
    const get = (key) =>
      new Promise((resolve, reject) => {
        const task = inspect.get(key);
        task.onsuccess = () => resolve(task.result);
        task.onerror = reject;
      });
    const [oldForeign, activeForeign, oldOwned] = await Promise.all([
      get(expiredKey),
      get(foreignKey),
      get(expiredOwnKey),
    ]);
    db.close();
    return {
      expiredReadRejected,
      expiredPurged: !oldForeign && !oldOwned,
      foreignPreserved: !!activeForeign,
    };
  });
  assert.deepEqual(retention, {
    expiredReadRejected: true,
    expiredPurged: true,
    foreignPreserved: true,
  });
  pass(
    "expired snapshots are removed with bounded cursors while unexpired foreign-account data remains intact",
  );

  const quota = await page.evaluate(async () => {
    const parts = [
      {
        kind: "file",
        fileName: "large.pdf",
        mediaType: "application/pdf",
        text: "x".repeat(11 * 1024 * 1024),
      },
    ];
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await window.documentResearch.save(parts, "quota-owner"));
    let code;
    try {
      await window.documentResearch.save(parts, "quota-owner");
    } catch (error) {
      code = error.code;
    }
    const recovered = await window.documentResearch.recover(keys[0], "quota-owner");
    return { code, priorLength: recovered[0].text.length };
  });
  assert.equal(quota.code, "document_cache");
  assert.equal(quota.priorLength, 11 * 1024 * 1024);
  pass("the account quota rejects excess writes without evicting an existing unexpired snapshot");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "synthetic-charts.pdf", mimeType: "application/pdf", buffer: sample });
  await page.getByRole("checkbox", { name: /读取 PDF 图表/ }).check();
  await page.getByRole("textbox", { name: "图表页码", exact: true }).fill("0");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "PDF 页码无效" }).waitFor();
  assert.equal(await page.locator("textarea").inputValue(), "Compare the charts");
  assert.equal(await page.getByRole("checkbox", { name: /读取 PDF 图表/ }).isChecked(), true);
  await page.getByRole("button", { name: "Vision fixture", exact: true }).click();
  await page.getByRole("checkbox", { name: /读取 PDF 图表/ }).uncheck();
  assert.equal(await page.getByRole("checkbox", { name: /读取 PDF 图表/ }).isDisabled(), true);
  pass(
    "invalid ranges retain the draft/file, and an incompatible model can turn off an existing layout selection",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  await writeFile(
    path.join(evidence, "browser-results.json"),
    JSON.stringify(
      {
        checks,
        errors,
        unexpectedNetwork: network,
        graphPixels: pixels,
        images: 1,
        sourcePages: [2],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await vite.close();
}
