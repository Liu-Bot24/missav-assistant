// Cost of one card change on long lists under the shipped default settings
// (performer limit, names on covers, default hidden category).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch } = require('./browser.cjs');
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

async function run(browser, count) {
  const page = await browser.newPage();
  await page.route("https://missav.ai/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("https://missav.ai/cn/new");
  await page.setContent(`<!doctype html><style>.grid{display:grid;grid-template-columns:repeat(4,1fr)}${read("content.css")}</style><div class="grid" id="grid"></div>`);
  await page.evaluate((count) => {
    for (let i = 0; i < count; i += 1) {
      const item = document.createElement("div");
      item.innerHTML = `<div class="thumbnail"><a href="https://missav.ai/cn/abc-${i}">x</a><span class="bottom-1 left-1">中文字幕</span></div>`;
      grid.append(item);
    }
    window.metrics = { messages: 0, computed: 0, delayedSet: 0, delayedFired: 0 };
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = function (callback, delay, ...rest) {
      if (typeof callback !== "function" || !(delay >= 500)) return nativeSetTimeout.call(this, callback, delay, ...rest);
      metrics.delayedSet += 1;
      return nativeSetTimeout.call(this, (...args) => {
        try { callback(...args); } finally { metrics.delayedFired += 1; }
      }, delay, ...rest);
    };
    const computed = window.getComputedStyle;
    window.getComputedStyle = function (...args) { metrics.computed += 1; return computed.apply(this, args); };
    window.chrome = {
      runtime: { sendMessage(message, callback) {
        metrics.messages += 1;
        setTimeout(() => callback({ ok: true, items: Object.fromEntries(message.itemIds.map((id) => [id, {
          genres: ["中出し"], tags: [], type: "jav", duration: 7000, actresses: ["A", "B"],
          cast: { names: ["A", "B"], count: 2 } }])) }), 40);
      } },
      storage: { local: { get(_keys, callback) { callback({ settingsVersion: 2 }); } }, onChanged: { addListener() {} } }
    };
  }, count);
  for (const file of ["text.js", "site-library.js", "label-library.js", "category-library.js", "settings.js", "metadata-client.js"]) {
    await page.addScriptTag({ content: read(file) });
  }
  const result = await page.evaluate(async (source) => {
    const start = performance.now();
    (0, eval)(source);
    await new Promise((resolve) => {
      const tick = () => document.querySelector(".viewing-assistant-pending") ? setTimeout(tick, 5) : resolve();
      setTimeout(tick, 5);
    });
    const settleMs = performance.now() - start;
    // The script scans once more a while after load. On a slow machine that
    // scan can land after settling, and it is not the cost of one change, so
    // the change is measured once the delayed timers have fired and reads stop.
    await new Promise((resolve) => {
      let last = -1;
      const quiet = () => {
        if (metrics.delayedFired >= metrics.delayedSet && metrics.computed === last) resolve();
        else { last = metrics.computed; setTimeout(quiet, 100); }
      };
      quiet();
    });
    const before = metrics.computed;
    const changeStart = performance.now();
    grid.firstElementChild.querySelector(".thumbnail").append(document.createElement("i"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { settleMs: Math.round(settleMs), messages: metrics.messages,
      changeMs: Math.round((performance.now() - changeStart) * 10) / 10,
      styleReadsPerChange: metrics.computed - before,
      visible: [...grid.children].filter((item) => getComputedStyle(item).display !== "none").length };
  }, read("content.js"));
  await page.close();
  return { count, ...result };
}

(async () => {
  const browser = await launch();
  try {
    for (const count of [60, 300, 1000]) {
      const result = await run(browser, count);
      console.log(JSON.stringify(result));
      assert.equal(result.visible, count, "default rules keep these cards");
      // One changed card must not re-read the styles of the whole list.
      assert.ok(result.styleReadsPerChange <= 4, `style reads per change: ${result.styleReadsPerChange}`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
