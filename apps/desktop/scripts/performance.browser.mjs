import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = process.env.OPENHORN_PERF_EVIDENCE || "/tmp/openhorn-performance";
const output = path.join(evidence, "build");
await mkdir(evidence, { recursive: true });
process.chdir(root);
if (process.env.OPENHORN_PERF_REUSE_BUILD !== "1")
  await build({
    root,
    configFile: path.join(root, "vite.config.ts"),
    build: {
      outDir: output,
      emptyOutDir: true,
      manifest: true,
      rollupOptions: { input: path.join(root, "tests/performance.html") },
    },
  });
const server = http.createServer(async (request, response) => {
  try {
    const file = path.resolve(output, `.${new URL(request.url, "http://fixture").pathname}`);
    if (!file.startsWith(`${output}/`)) throw new Error("invalid path");
    let data = await readFile(file);
    // Older baseline fixtures used a class outside Tailwind's production scan.
    // Pin the same viewport height in both builds so list measurements are comparable.
    if (file.endsWith("performance.html"))
      data = Buffer.from(
        data.toString().replace("</head>", "<style>.h-screen{height:100dvh}</style></head>"),
      );
    response.setHeader(
      "Content-Type",
      file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".css")
          ? "text/css"
          : "application/javascript",
    );
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [],
  checks = [],
  errors = [],
  unexpected = [];
const repeats = Number(process.env.OPENHORN_PERF_REPEATS || 3);
try {
  for (const mode of ["app", "sidebar"])
    for (const count of [344, 5000])
      for (let run = 0; run < repeats; run++) {
        console.log(`Measuring ${mode} ${count} run ${run}`);
        const conversations = Array.from({ length: count }, (_, index) => ({
          id: `perf-${index}`,
          title: `Perf conversation ${String(index).padStart(6, "0")}`,
          channelId: null,
          modelId: null,
          contextLength: 4096,
          defaultMode: "agent",
          lastMode: "agent",
          isPinned: index < 3,
          forceWebSearch: false,
          projectId: index >= count - 12 ? "perf-project" : null,
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(() => {
          window.perfLongTasks = [];
          try {
            new PerformanceObserver((list) => {
              window.perfLongTasks.push(...list.getEntries().map((entry) => entry.duration));
            }).observe({ type: "longtask", buffered: true });
          } catch {}
        });
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          if (url.origin !== "http://127.0.0.1:3002") {
            unexpected.push(url.href);
            console.log("BLOCKED", url.href);
            return route.abort();
          }
          const json = (value) =>
            route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
          if (route.request().method() === "OPTIONS") return json({});
          if (url.pathname === "/scheduled-tasks") return json({ tasks: [] });
          if (url.pathname === "/scheduled-tasks/runs") return json({ runs: [] });
          if (url.pathname === "/search")
            return json({
              results: [
                {
                  kind: "message",
                  id: "deep-result",
                  messageId: "deep-result",
                  conversationId: `perf-${count - 13}`,
                  title: conversations[count - 13].title,
                  snippet: "Deep fixture match",
                },
              ],
            });
          if (url.pathname.startsWith("/messages/")) return json({ messages: [] });
          if (url.pathname === "/channels") return json({ channels: [] });
          if (url.pathname === "/mcp/servers") return json({ servers: [] });
          if (url.pathname === "/settings/welcome-suggestions")
            return json({ suggestions: [], stale: false });
          if (url.pathname === "/settings/search-status")
            return json({ configured: false, source: "none" });
          if (url.pathname === "/settings") return json({ settings: {} });
          if (["/auth/me", "/conversations", "/projects"].includes(url.pathname)) {
            const fixture = {
              user: { id: "perf-user", username: "Performance", email: "perf@openhorn.local" },
              conversations,
              projects: [
                {
                  id: "perf-project",
                  userId: "perf-user",
                  name: "Perf project",
                  rootPath: "/synthetic/project",
                  isStarred: false,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            };
            return json(
              url.pathname === "/auth/me"
                ? { user: fixture.user }
                : url.pathname === "/projects"
                  ? { projects: fixture.projects }
                  : { conversations: fixture.conversations },
            );
          }
          unexpected.push(url.pathname);
          console.log("UNEXPECTED", url.pathname);
          return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(15000);
        page.on("pageerror", (error) => {
          errors.push(error.message);
          console.log("PAGE ERROR", error.message);
        });
        page.on("console", (message) => {
          if (message.type() === "error") console.log("CONSOLE", message.text());
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(`${origin}/tests/performance.html?mode=${mode}&count=${count}`, {
          waitUntil: "domcontentloaded",
        });
        console.log("Navigated", mode, count);
        await page.waitForFunction(() => Number.isFinite(window.perfReadyAt));
        console.log("Rows ready", mode, count);
        const initial = await page.evaluate(async () => {
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          return {
            readyMs: window.perfReadyAt,
            elements: document.querySelectorAll("*").length,
            rows: document.querySelectorAll('[data-radix-scroll-area-viewport] [role="button"]')
              .length,
            jsBytes: performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.endsWith(".js"))
              .reduce((sum, entry) => sum + entry.decodedBodySize, 0),
            longTasks: [...window.perfLongTasks],
            viewportHeight: document.querySelector("[data-radix-scroll-area-viewport]")
              .clientHeight,
          };
        });
        const selection = [];
        assert.ok(
          initial.viewportHeight > 100 && initial.viewportHeight < 1200,
          "Sidebar must have a bounded viewport",
        );
        if (mode === "sidebar") {
          for (const index of [3, 4, 5])
            selection.push(
              await page.evaluate(async (i) => {
                const started = performance.now();
                await window.perfFixture.select(i);
                await new Promise((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(done)),
                );
                return performance.now() - started;
              }, index),
            );
          await page.getByTestId("selected").filter({ hasText: "000005" }).waitFor();
        }
        const frames = await page.evaluate(async () => {
          const viewport = document.querySelector("[data-radix-scroll-area-viewport]");
          const samples = [];
          let previous = performance.now();
          for (let i = 0; i < 30; i++)
            await new Promise((done) =>
              requestAnimationFrame(() => {
                const now = performance.now();
                samples.push(now - previous);
                previous = now;
                viewport.scrollTop += 300;
                done();
              }),
            );
          viewport.scrollTop = viewport.scrollHeight;
          return samples;
        });
        const lastPlain = String(count - 13).padStart(6, "0");
        await page
          .getByText(`Perf conversation ${lastPlain}`, { exact: true })
          .waitFor({ state: "visible" });
        const entry = {
          mode,
          count,
          run,
          ...initial,
          selectionMs: selection,
          frameP95Ms: [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.95)],
        };
        results.push(entry);
        console.log(JSON.stringify(entry));
        if (
          process.env.OPENHORN_PERF_CHECKS === "1" &&
          mode === "sidebar" &&
          count === 5000 &&
          run === repeats - 1
        ) {
          const record = (name) => {
            checks.push(name);
            console.log(`PASS ${name}`);
          };
          const assertInViewport = async (locator) =>
            assert.ok(
              await locator.evaluate(
                (element) =>
                  new Promise((done) =>
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        const viewport = element
                          .closest("[data-radix-scroll-area-viewport]")
                          .getBoundingClientRect();
                        const rect = element.getBoundingClientRect();
                        done(rect.top >= viewport.top - 2 && rect.bottom <= viewport.bottom + 2);
                      }),
                    ),
                  ),
              ),
              "Virtual row must actually be within the scroll viewport",
            );
          assert.ok(initial.rows < 80 && initial.elements < 2000);
          const viewport = page.locator("[data-radix-scroll-area-viewport]").first();
          await viewport.evaluate((element) => {
            element.scrollTop = 0;
          });
          const firstRow = page.getByRole("button", {
            name: "Perf conversation 000003",
            exact: true,
          });
          const lastRow = page.getByRole("button", {
            name: `Perf conversation ${lastPlain}`,
            exact: true,
          });
          await firstRow.waitFor({ state: "visible" });
          await firstRow.focus();
          await firstRow.press("End");
          await lastRow.waitFor({ state: "visible" });
          await assertInViewport(lastRow);
          assert.equal(
            await lastRow.evaluate((element) => element === document.activeElement),
            true,
          );
          await lastRow.press("Home");
          await firstRow.waitFor({ state: "visible" });
          await firstRow.press("ArrowDown");
          assert.equal(
            await page
              .getByRole("button", { name: "Perf conversation 000004", exact: true })
              .evaluate((element) => element === document.activeElement),
            true,
          );
          record(
            "virtual history keeps bounded DOM and supports keyboard navigation through unmounted rows",
          );
          await firstRow.locator("button").click();
          await page.getByRole("menuitem", { name: "重命名", exact: true }).waitFor();
          await viewport.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          assert.equal(
            await page
              .getByRole("button", {
                name: "Perf conversation 000003",
                exact: true,
                includeHidden: true,
              })
              .count(),
            1,
          );
          assert.equal(
            await page
              .getByRole("menuitem", { name: "重命名", exact: true, includeHidden: true })
              .count(),
            1,
          );
          await viewport.evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
          const rename = page.getByRole("textbox");
          await rename.waitFor();
          assert.equal(await rename.inputValue(), "Perf conversation 000003");
          await rename.press("Escape");
          record("a conversation menu remains attached to its retained row during a long scroll");
          await viewport.evaluate((element) => {
            element.scrollTop = 0;
          });
          await page.getByRole("button", { name: "Perf project", exact: true }).click();
          await viewport.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await lastRow.waitFor({ state: "visible" });
          await assertInViewport(lastRow);
          await page.getByRole("button", { name: "统一搜索", exact: true }).click();
          const search = page.getByRole("textbox", { name: "统一搜索", exact: true });
          await search.fill("deep");
          await page.getByText("Deep fixture match", { exact: true }).click();
          await page.getByTestId("selected").filter({ hasText: lastPlain }).waitFor();
          await search.press("Escape");
          record("project expansion preserves virtual offsets and search can select deep history");
          let releaseSyntax;
          const syntaxGate = new Promise((done) => {
            releaseSyntax = done;
          });
          await context.route("**/*DesktopSyntaxHighlighter-*.js", async (route) => {
            await syntaxGate;
            await route.continue();
          });
          await page.addInitScript(() => {
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: async (text) => {
                  window.perfCopiedText = text;
                },
              },
            });
          });
          await page.goto(`${origin}/tests/performance.html?mode=markdown&count=0`, {
            waitUntil: "domcontentloaded",
          });
          const copy = page.getByTitle("Copy code", { exact: true });
          await copy.waitFor();
          const before = await page
            .locator("code")
            .evaluate((element) => element.parentElement.getBoundingClientRect().height);
          await copy.focus();
          await copy.press("Enter");
          assert.equal(
            await page.evaluate(() => window.perfCopiedText),
            "const stable = 42;\nconsole.log(stable);",
          );
          releaseSyntax();
          const keyword = page.locator("code").getByText("const", { exact: true }).first();
          await keyword.waitFor();
          const after = await page
            .locator("code")
            .evaluate((element) => element.parentElement.getBoundingClientRect().height);
          assert.ok(Math.abs(after - before) <= 2, `Code height changed ${before} -> ${after}`);
          const light = await keyword.evaluate((element) => getComputedStyle(element).color);
          await page.evaluate(() => window.perfFixture.toggleTheme());
          await page.waitForFunction(
            (previous) =>
              getComputedStyle(
                Array.from(document.querySelectorAll("code span")).find(
                  (element) => element.textContent === "const",
                ),
              ).color !== previous,
            light,
          );
          record(
            "deferred code highlighting preserves copy bytes, line height and live theme changes",
          );
        }
        await context.close();
      }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  await writeFile(
    path.join(evidence, "results.json"),
    `${JSON.stringify({ cpuThrottle: 4, browser: "Chrome headless, production build, fresh context", results, checks, errors, unexpected }, null, 2)}\n`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
