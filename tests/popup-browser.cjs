const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.saved = { blockedPresets: ['english-subtitle'], customLabels: ['obsolete'], genreExcludeRules: [] };
      window.chrome = { runtime: {},
        tabs: { query(_options, callback) { callback([{ id: 1 }]); },
          sendMessage(_id, _message, callback) { callback({ compatible: true, metadata: "missav", pageKind: "list" }); } },
        storage: {
        sync: { get(defaults, cb) { cb({ ...defaults, ...window.saved }); },
          set(settings, cb) { window.saved = structuredClone(settings); cb(); } },
        local: { get(defaults, cb) { cb(defaults); } },
        onChanged: { addListener() {} }
      } };
    });
    await page.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.equal(await page.locator('[value="other-subtitle"]').isChecked(), true);
    assert.equal(await page.locator('#customForm').count(), 0);
    assert.equal(await page.locator('#ruleSummary').textContent(), '当前启用 1 条规则');
    await page.locator('label.rule-row').filter({ has: page.locator('#hideUntagged') }).click();
    assert.equal(await page.evaluate(() => window.saved.hideUntagged), true);
    assert.deepEqual(await page.evaluate(() => window.saved.blockedPresets), ['other-subtitle']);
    assert.equal(await page.evaluate(() => Object.hasOwn(window.saved, 'customLabels')), false);
    assert.equal(await page.locator('h1').textContent(), '观看小助手');
    assert.equal(await page.locator('#homepageEnabled').isChecked(), true);
    await page.locator('label.scroll-control').filter({ has: page.locator('#homepageEnabled') }).click();
    assert.equal(await page.evaluate(() => window.saved.homepageEnabled), false);
    await page.locator('label.scroll-control').filter({ has: page.locator('#infiniteScroll') }).click();
    assert.equal(await page.evaluate(() => window.saved.infiniteScroll), true);
    await page.locator('#genreIncludeSearch').fill('4小时');
    await page.locator('#genreIncludeSuggestions [role="option"]').first().click();
    assert.equal(await page.locator('#genreIncludeField .selected-genre-chip').count(), 1);
    await page.locator('#genreIncludeField .selected-genre-chip button').click();
    assert.equal(await page.locator('#genreIncludeField .selected-genre-chip').count(), 0);
    await page.locator('#resetButton').click();
    assert.deepEqual(await page.evaluate(() => window.saved.blockedPresets), ['uncensored']);
    assert.equal(await page.locator('#hideUntagged').isChecked(), false);
    assert.equal(await page.locator('#infiniteScroll').isChecked(), false);
    assert.equal(await page.locator('#homepageEnabled').isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#siteStatus').textContent(), '当前页面支持标签与分类筛选。');
    const partial = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await partial.addInitScript(() => {
      window.chrome = { runtime: {}, tabs: {
        query(_options, cb) { cb([{ id: 1 }]); },
        sendMessage(_id, _msg, cb) { cb({ compatible: true, metadata: null, pageKind: 'list' }); }
      } };
    });
    await partial.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.match(await partial.locator('#siteStatus').textContent(), /分类筛选尚未适配/);
    assert.match(await partial.locator('#genreExplainer').textContent(), /仅在支持分类的网站生效/);
    assert.match(await partial.locator('#ruleSummary').textContent(), /已保存/);
    await partial.close();
    assert.deepEqual(errors, []);
    const dir = path.join(root, 'output', 'playwright');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'popup-1.0.0.png'), fullPage: true });
    console.log(JSON.stringify({ popup: 'passed', errors, height: await page.locator('body').evaluate(el => el.scrollHeight) }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
