// Optional browser integration check. Set PLAYWRIGHT_MODULE and, if needed,
// CHROMIUM_EXECUTABLE to an existing local Playwright/Chromium installation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.join(__dirname, "..");
const library = fs.readFileSync(path.join(root, "genre-library.js"), "utf8");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const current = fs.readFileSync(path.join(root, "content.js"), "utf8");
const baseline = execFileSync("git", ["show", "03d64ff:content.js"], { cwd: root, encoding: "utf8" });

async function install(page, source, count, home = false) {
  if (page.url() === "about:blank") {
    await page.route('https://missav.ai/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto('https://missav.ai/new');
  }
  await page.setContent(`<!doctype html><style>
    .grid { display:grid;grid-template-columns:repeat(4,1fr);gap:8px }
    .card { padding:8px;border:1px solid #888 }
    ${css}</style><main><div class="grid" id="grid"></div>
    ${home ? '<button id="more">载入更多</button>' : ""}</main>`);
  await page.evaluate(({ count, home }) => {
    window.makeCard = (id, blocked = false) => {
      const item = document.createElement("div");
      item.className = "card";
      item.innerHTML = `<div class="thumbnail"><a href="https://missav.ai/sample-${id}">Card ${id}</a>
        <span class="bottom-1 left-1" ${blocked ? "" : 'style="display:none"'}>中文字幕</span></div>`;
      return item;
    };
    for (let i = 0; i < count; i += 1) grid.append(makeCard(i, i % 2 === 0));
    window.metrics = { gridEnumerations: 0, clicks: 0, messages: 0, blockedPeak: 0, visibleSequences: [] };
    const query = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (selector) {
      if (this.id === "grid" && selector === "div.thumbnail") metrics.gridEnumerations += 1;
      return query.call(this, selector);
    };
    window.chrome = {
      runtime: { sendMessage(message, callback) {
        metrics.messages += 1;
        setTimeout(() => callback({ ok: true, items: Object.fromEntries(message.itemIds.map((id) =>
          [id, { genres: ["sample"], tags: [], type: "sample", duration: 100 }]
        )) }), 40);
      } },
      storage: {
        sync: { get(defaults, callback) {
          callback({ ...defaults, blockedPresets: ["chinese-subtitle"], genreExcludeRules: home ? ["value:blocked"] : [] });
        } },
        onChanged: { addListener(listener) { window.changeSettings = listener; } }
      }
    };
    if (home) more.addEventListener("click", () => {
      metrics.clicks += 1;
      // Match a site's asynchronous load and its late badge update.
      more.disabled = true;
      setTimeout(() => {
        const start = grid.children.length;
        for (let i = 0; i < 4; i += 1) grid.append(makeCard(start + i, false));
        setTimeout(() => { grid.lastElementChild.querySelector("span").style.display = ""; }, 100);
        more.disabled = false;
      }, 30);
    });
  }, { count, home });
  if (source === baseline) await page.evaluate(() => document.documentElement.setAttribute("data-viewing-assistant", ""));
  await page.addScriptTag({ path: path.join(root, "site-library.js") });
  await page.addScriptTag({ path: path.join(root, "label-library.js") });
  await page.addScriptTag({ content: library });
  return page.evaluate(async (source) => {
    const start = performance.now();
    (0, eval)(source);
    window.observeFrames = true;
    const sample = () => {
      if (!window.observeFrames) return;
      const visible = [...grid.children].filter((item) => {
        const style = getComputedStyle(item);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      metrics.blockedPeak = Math.max(metrics.blockedPeak, visible.filter((item) =>
        getComputedStyle(item.querySelector("span")).display !== "none"
      ).length);
      const signature = visible.map((item) => item.querySelector("a").getAttribute("href")).join("|");
      if (signature && metrics.visibleSequences.at(-1) !== signature) metrics.visibleSequences.push(signature);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { ms: performance.now() - start, gridEnumerations: metrics.gridEnumerations };
  }, source);
}

async function measure(browser, source, count) {
  const page = await browser.newPage();
  try {
    const initial = await install(page, source, count);
    const insertion = await page.evaluate(async () => {
      const start = performance.now();
      grid.append(makeCard(99999, true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ms: performance.now() - start, gridEnumerations: metrics.gridEnumerations,
        hidden: document.querySelectorAll(".missav-content-filter-hidden").length,
        addedHidden: getComputedStyle(grid.lastElementChild).display === "none" };
    });
    assert.equal(insertion.hidden, count / 2 + 1);
    assert.equal(insertion.addedHidden, true);
    return { initial, insertion };
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const results = [];
    for (const count of process.argv.includes("home") ? [] : [300, 1000]) {
      for (let repeat = 0; repeat < 3; repeat += 1) {
        results.push({ count, repeat, baseline: await measure(browser, baseline, count),
          optimized: await measure(browser, current, count) });
      }
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = [300, 1000].filter((count) => results.some((r) => r.count === count)).map((count) => {
      const runs = results.filter((r) => r.count === count);
      return { count,
        initialMs: { baseline: median(runs.map((r) => r.baseline.initial.ms)),
          optimized: median(runs.map((r) => r.optimized.initial.ms)) },
        insertionMs: { baseline: median(runs.map((r) => r.baseline.insertion.ms)),
          optimized: median(runs.map((r) => r.optimized.insertion.ms)) },
        initialGridEnumerations: { baseline: runs[0].baseline.initial.gridEnumerations,
          optimized: runs[0].optimized.initial.gridEnumerations } };
    });
    console.log(JSON.stringify({ benchmarkMedians: summary }, null, 2));
    const home = await browser.newPage();
    await home.route('https://missav.ai/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await home.goto('https://missav.ai/cn');
    try {
      await install(home, process.argv.includes("baseline") ? baseline : current, 12, true);
      await home.waitForFunction(() => metrics.clicks > 0 &&
        !grid.classList.contains("missav-content-filter-grid-settling") &&
        !document.querySelector(".missav-content-filter-pending") && metrics.visibleSequences.length > 0,
        null, { timeout: 12000 });
      const state = await home.evaluate(() => ({
        clicks: metrics.clicks, messages: metrics.messages, blockedPeak: metrics.blockedPeak,
        visibleSequenceCount: metrics.visibleSequences.length,
        visible: [...grid.children].filter((item) => getComputedStyle(item).display !== "none").length,
        visibleBlocked: [...grid.children].filter((item) => getComputedStyle(item).display !== "none" &&
          getComputedStyle(item.querySelector("span")).display !== "none").length
      }));
      console.log(JSON.stringify({ homepage: state }));
      assert.ok(state.visible >= 8, "首页应补到至少八项");
      assert.equal(state.visibleBlocked, 0, "稳定遮罩撤销后不能显示被屏蔽标签");
      assert.equal(state.blockedPeak, 0, "任何已绘制帧都不能显示被屏蔽标签");
      assert.equal(state.visibleSequenceCount, 1, "首页应直接从遮罩进入最终结果");
      assert.equal(state.clicks, 1, "九项合格结果应停止补位");
      await home.evaluate(() => {
        window.observeFrames = false;
        changeSettings({ homepageEnabled: { newValue: false } }, 'sync');
        grid.append(makeCard(9999, true));
      });
      await home.waitForTimeout(100);
      assert.equal(await home.locator('.missav-content-filter-hidden').count(), 0);
      assert.equal(await home.locator('.missav-content-filter-grid-settling').count(), 0);
      assert.equal(await home.evaluate(() => metrics.clicks), 1);
      await home.evaluate(() => changeSettings({ homepageEnabled: { newValue: true } }, 'sync'));
      await home.waitForFunction(() => getComputedStyle(grid.lastElementChild).display === 'none');
      assert.equal(await home.evaluate(() => metrics.clicks), 1);
      console.log(JSON.stringify({ homepageToggle: 'restores native cards and resumes filtering' }));
    } finally { await home.close(); }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
