const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launch } = require('./browser.cjs');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.saved = { settingsVersion: 2, hiddenLabels: ['other-subtitle'], categoryExcludeRules: [] };
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
    assert.equal(await page.locator('#ruleSummary').textContent(), '当前启用 1 条规则', 'the performer limit is off by default');
    await page.locator('label.rule-row').filter({ has: page.locator('#hideUntagged') }).click();
    assert.equal(await page.evaluate(() => window.saved.hideUntagged), true);
    assert.deepEqual(await page.evaluate(() => window.saved.hiddenLabels), ['other-subtitle']);
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
    // Features that look videos up are off by default.
    assert.equal(await page.locator('#actressLimitEnabled').isChecked(), false);
    assert.equal(await page.locator('#showActressNames').isChecked(), false);
    assert.equal(await page.locator('#maxActresses').isDisabled(), true);
    assert.equal(await page.locator('#maxActresses').inputValue(), '3');
    await page.locator('label[for="actressLimitEnabled"]').click();
    assert.equal(await page.evaluate(() => window.saved.actressLimitEnabled), true);
    assert.equal(await page.locator('#maxActresses').isDisabled(), false);
    await page.locator('label[for="showActressNames"]').click();
    assert.equal(await page.evaluate(() => window.saved.showActressNames), true);
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
    await page.locator('#resetButton').click();
    assert.equal(await page.locator('#maxActresses').inputValue(), '3');
    assert.equal(await page.locator('#actressLimitEnabled').isChecked(), false);
    assert.equal(await page.locator('#showActressNames').isChecked(), false);
    assert.equal(await page.evaluate(() => window.saved.showActressNames), false);
    // Reopening the popup after a reset still offers the undo until it expires.
    for (const [remaining, failFirstSave] of [[8000, false], [8000, true], [-1, false]]) {
      const reopened = await browser.newPage({ viewport: { width: 380, height: 600 } });
      reopened.on('pageerror', error => errors.push(error.message));
      await reopened.addInitScript(({ remaining, failFirstSave }) => {
        window.saved = { settingsVersion: 2 };
        window.sessionSaved = { resetUndo: { settings: { hideUntagged: true, maxActresses: 7 }, expiresAt: Date.now() + remaining } };
        const area = (name) => ({
          get(keys, cb) {
            const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
            const defaults = keys && !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
            cb(Object.fromEntries(list.filter((key) => Object.hasOwn(window[name], key) || Object.hasOwn(defaults, key))
              .map((key) => [key, Object.hasOwn(window[name], key) ? structuredClone(window[name][key]) : defaults[key]])));
          },
          set(value, cb) {
            if (name === 'saved' && window.failNextSave) {
              window.failNextSave = false;
              chrome.runtime.lastError = { message: 'fixture failure' };
              cb?.();
              chrome.runtime.lastError = null;
              return;
            }
            window[name] = { ...window[name], ...structuredClone(value) }; cb?.();
          },
          remove(keys, cb) { const next = { ...window[name] }; for (const key of [].concat(keys)) delete next[key]; window[name] = next; cb?.(); }
        });
        window.failNextSave = failFirstSave;
        window.chrome = { runtime: { lastError: null },
          tabs: { query(_options, callback) { callback([{ id: 1 }]); },
            sendMessage(_id, _message, callback) { callback({ compatible: true, metadata: "missav", pageKind: "list" }); } },
          storage: { local: area('saved'), session: area('sessionSaved'), onChanged: { addListener() {} } } };
      }, { remaining, failFirstSave });
      await reopened.goto(pathToFileURL(path.join(root, 'popup.html')).href);
      await reopened.waitForTimeout(100);
      if (remaining > 0) {
        assert.equal(await reopened.locator('#resetButton').textContent(), '撤销', 'the undo is still offered after reopening');
        if (failFirstSave) {
          await reopened.locator('#resetButton').click();
          assert.equal(await reopened.locator('#resetButton').textContent(), '撤销', 'a failed restore can be tried again');
          assert.equal(await reopened.evaluate(() => Object.hasOwn(window.sessionSaved, 'resetUndo')), true);
        }
        await reopened.locator('#resetButton').click();
        assert.equal(await reopened.evaluate(() => window.saved.hideUntagged), true);
        assert.equal(await reopened.evaluate(() => window.saved.maxActresses), 7);
        assert.equal(await reopened.evaluate(() => Object.hasOwn(window.sessionSaved, 'resetUndo')), false);
      } else {
        assert.equal(await reopened.locator('#resetButton').textContent(), '恢复默认', 'an expired undo is not offered');
      }
      await reopened.close();
    }
    // Earlier preferences that could not be migrated yet: a reset would leave them in place.
    const pending = await browser.newPage({ viewport: { width: 380, height: 600 } });
    pending.on('pageerror', error => errors.push(error.message));
    await pending.addInitScript(() => {
      window.saved = { hideUntagged: true };
      const area = (state, fail) => ({
        get(_keys, cb) { setTimeout(() => { if (fail) chrome.runtime.lastError = { message: 'fixture failure' }; cb(structuredClone(state)); chrome.runtime.lastError = null; }); },
        set(value, cb) { Object.assign(state, structuredClone(value)); cb?.(); },
        remove(_keys, cb) { cb?.(); }
      });
      window.chrome = { runtime: { lastError: null },
        tabs: { query(_options, cb) { cb([{ id: 1 }]); }, sendMessage(_id, _msg, cb) { cb({ compatible: true, metadata: 'missav', pageKind: 'list' }); } },
        storage: { local: area(window.saved, false), sync: area({ blockedPresets: ['chinese-subtitle'] }, true), onChanged: { addListener() {} } } };
    });
    await pending.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    await pending.waitForTimeout(100);
    assert.equal(await pending.locator('#hideUntagged').isChecked(), true);
    assert.equal(await pending.locator('#resetButton').isDisabled(), true, 'no reset while earlier preferences wait to be migrated');
    await pending.close();
    // Search looks past the 500 most used categories and ignores separators.
    const many = await browser.newPage({ viewport: { width: 380, height: 600 } });
    many.on('pageerror', error => errors.push(error.message));
    await many.addInitScript(() => {
      const counts = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`common-${String(i).padStart(3, '0')}`, 5]));
      const state = { settingsVersion: 2, discoveredCategories: { ...counts, 'rare-zero-cat': 0, 'エステマッサージ': 3, '女優ベスト・総集編': 10 } };
      const area = {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
          const defaults = keys && !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
          setTimeout(() => cb(Object.fromEntries(list.filter((key) => Object.hasOwn(state, key) || Object.hasOwn(defaults, key))
            .map((key) => [key, Object.hasOwn(state, key) ? structuredClone(state[key]) : defaults[key]]))));
        },
        set(value, cb) { Object.assign(state, structuredClone(value)); setTimeout(() => cb?.()); },
        remove(_keys, cb) { setTimeout(() => cb?.()); }
      };
      window.chrome = { runtime: { lastError: null },
        tabs: { query(_options, cb) { cb([{ id: 1 }]); }, sendMessage(_id, _msg, cb) { cb({ compatible: true, metadata: 'missav', pageKind: 'list' }); } },
        storage: { local: area, onChanged: { addListener() {} } } };
    });
    await many.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    await many.waitForTimeout(100);
    const suggestions = many.locator('#categoryIncludeSuggestions [role="option"]');
    await many.locator('#categoryIncludeSearch').fill('rare-zero-cat');
    assert.equal(await suggestions.count(), 1, 'a category outside the 500 most used is found by search');
    await many.locator('#categoryIncludeSearch').fill('エステマッサージ');
    assert.match(await suggestions.first().textContent(), /美容按摩/, "the site's spelling without the separator finds the category");
    const chips = many.locator('#categoryIncludeField .selected-category-chip');
    await many.locator('#categoryIncludeSearch').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await chips.count(), 0, 'the Enter that confirms input-method text adds nothing');
    await many.locator('#categoryIncludeSearch').fill('ベスト、総集編');
    await many.locator('#categoryIncludeSearch').press('Enter');
    assert.equal((await chips.first().textContent()).replace('×', ''), '合集', 'Enter picks the category whose full name was typed');
    await many.close();
    const partial = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await partial.addInitScript(() => {
      window.chrome = { runtime: {}, tabs: {
        query(_options, cb) { cb([{ id: 1 }]); },
        sendMessage(_id, _msg, cb) { cb({ compatible: true, metadata: null, pageKind: 'list' }); }
      } };
    });
    await partial.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.match(await partial.locator('#siteStatus').textContent(), /分类和女优功能只在 MissAV 上可用/);
    assert.match(await partial.locator('#categoryExplainer').textContent(), /只在 MissAV 上生效/);
    assert.match(await partial.locator('#ruleSummary').textContent(), /已保存/);
    await partial.close();
    assert.deepEqual(errors, []);
    const dir = path.join(root, 'output', 'playwright');
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'popup-1.0.0.png'), fullPage: true });
    console.log(JSON.stringify({ popup: 'passed', errors, height: await page.locator('body').evaluate(el => el.scrollHeight) }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
