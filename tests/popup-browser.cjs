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
      window.saved = { settingsVersion: 2, hiddenLabels: ['other-subtitle'], customLabels: ['obsolete'], categoryExcludeRules: [] };
      window.syncSaved = { enabled: true, hideUntagged: false, unrelated: 1 };
      // Callback form of chrome.storage areas: merging set, key lists or defaults on get.
      const area = (name) => ({
        get(keys, cb) {
          const state = window[name];
          const defaults = keys && !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(defaults);
          cb(Object.fromEntries(list.filter((key) => Object.hasOwn(state, key) || Object.hasOwn(defaults, key))
            .map((key) => [key, Object.hasOwn(state, key) ? structuredClone(state[key]) : defaults[key]])));
        },
        set(value, cb) { window.lastSet = structuredClone(value); window[name] = { ...window[name], ...structuredClone(value) }; cb?.(); },
        remove(keys, cb) { const next = { ...window[name] }; for (const key of [].concat(keys)) delete next[key]; window[name] = next; cb?.(); }
      });
      window.chrome = { runtime: {},
        tabs: { query(_options, callback) { callback([{ id: 1 }]); },
          sendMessage(_id, _message, callback) { callback({ compatible: true, metadata: "missav", pageKind: "list" }); } },
        storage: { local: area('saved'), sync: area('syncSaved'), onChanged: { addListener() {} } } };
    });
    await page.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.equal(await page.locator('#syncNotice').isVisible(), true, 'an old account copy is reported');
    await page.locator('#removeSyncCopy').click();
    assert.equal(await page.locator('#syncNotice').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.syncSaved), { unrelated: 1 }, 'only preference keys are removed');
    assert.equal(await page.locator('[value="other-subtitle"]').isChecked(), true);
    assert.equal(await page.locator('#customForm').count(), 0);
    assert.equal(await page.locator('#ruleSummary').textContent(), '当前启用 2 条规则');
    await page.locator('label.rule-row').filter({ has: page.locator('#hideUntagged') }).click();
    assert.equal(await page.evaluate(() => window.saved.hideUntagged), true);
    assert.deepEqual(await page.evaluate(() => window.saved.hiddenLabels), ['other-subtitle']);
    assert.equal(await page.evaluate(() => Object.hasOwn(window.lastSet, 'customLabels')), false);
    assert.equal(await page.evaluate(() => Object.hasOwn(window.syncSaved, 'hideUntagged')), false, 'saving never writes the account copy');
    assert.equal(await page.locator('h1').textContent(), '观看小助手');
    assert.equal(await page.locator('#homepageEnabled').isChecked(), true);
    await page.locator('label.scroll-control').filter({ has: page.locator('#homepageEnabled') }).click();
    assert.equal(await page.evaluate(() => window.saved.homepageEnabled), false);
    await page.locator('label.scroll-control').filter({ has: page.locator('#infiniteScroll') }).click();
    assert.equal(await page.evaluate(() => window.saved.infiniteScroll), true);
    await page.locator('#categoryIncludeSearch').fill('4小时');
    await page.locator('#categoryIncludeSuggestions [role="option"]').first().click();
    assert.equal(await page.locator('#categoryIncludeField .selected-category-chip').count(), 1);
    await page.locator('#categoryIncludeField .selected-category-chip button').click();
    assert.equal(await page.locator('#categoryIncludeField .selected-category-chip').count(), 0);
    await page.locator('#resetButton').click();
    assert.deepEqual(await page.evaluate(() => window.saved.hiddenLabels), ['uncensored']);
    assert.equal(await page.locator('#resetButton').textContent(), '撤销');
    await page.locator('#resetButton').click();
    assert.equal(await page.evaluate(() => window.saved.hideUntagged), true, 'undo restores the settings before the reset');
    assert.equal(await page.evaluate(() => window.saved.infiniteScroll), true);
    assert.equal(await page.locator('#resetButton').textContent(), '恢复默认');
    await page.locator('#resetButton').click();
    assert.deepEqual(await page.evaluate(() => window.saved.hiddenLabels), ['uncensored']);
    assert.equal(await page.locator('#hideUntagged').isChecked(), false);
    assert.equal(await page.locator('#infiniteScroll').isChecked(), false);
    assert.equal(await page.locator('#homepageEnabled').isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#siteStatus').textContent(), '当前页面支持标签、分类与女优筛选。');
    assert.equal(await page.locator('#actressLimitEnabled').isChecked(), true);
    assert.equal(await page.locator('#showActressNames').isChecked(), true);
    assert.equal(await page.locator('#maxActresses').inputValue(), '3');
    await page.locator('#maxActresses').fill('5');
    await page.locator('#maxActresses').blur();
    assert.equal(await page.evaluate(() => window.saved.maxActresses), 5);
    await page.locator('#maxActresses').fill('-1');
    await page.locator('#maxActresses').blur();
    assert.equal(await page.evaluate(() => window.saved.maxActresses), 5);
    assert.equal(await page.locator('#maxActresses').inputValue(), '5');
    await page.locator('label[for="actressLimitEnabled"]').click();
    assert.equal(await page.locator('#maxActresses').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.saved.actressLimitEnabled), false);
    await page.locator('label[for="showActressNames"]').click();
    assert.equal(await page.evaluate(() => window.saved.showActressNames), false);
    await page.locator('#resetButton').click();
    assert.equal(await page.locator('#maxActresses').inputValue(), '3');
    assert.equal(await page.locator('#actressLimitEnabled').isChecked(), true);
    assert.equal(await page.locator('#showActressNames').isChecked(), true);
    const partial = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await partial.addInitScript(() => {
      window.chrome = { runtime: {}, tabs: {
        query(_options, cb) { cb([{ id: 1 }]); },
        sendMessage(_id, _msg, cb) { cb({ compatible: true, metadata: null, pageKind: 'list' }); }
      } };
    });
    await partial.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.match(await partial.locator('#siteStatus').textContent(), /分类与女优筛选尚未适配/);
    assert.match(await partial.locator('#categoryExplainer').textContent(), /仅在支持分类的网站生效/);
    assert.match(await partial.locator('#ruleSummary').textContent(), /已保存/);
    await partial.close();
    assert.deepEqual(errors, []);
    const dir = path.join(root, 'output', 'playwright');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'popup-1.0.0.png'), fullPage: true });
    console.log(JSON.stringify({ popup: 'passed', errors, height: await page.locator('body').evaluate(el => el.scrollHeight) }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
