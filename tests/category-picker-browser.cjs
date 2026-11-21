const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launch } = require('./browser.cjs');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await launch();
  const failures = [];
  const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(`${name}: ${e.message}`); } };
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.saved = { settingsVersion: 2, categoryExcludeRules: ['value:' + encodeURIComponent('ハイビジョン')] };
      window.chrome = { storage: { local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : Object.keys(keys);
          cb(Object.fromEntries(list.filter((key) => Object.hasOwn(window.saved, key))
            .map((key) => [key, structuredClone(window.saved[key])])));
        },
        set(settings, cb) { window.saved = { ...window.saved, ...structuredClone(settings) }; cb?.(); }
      } } };
    });
    await page.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    assert.match(await page.locator('#categoryExcludeField .selected-category-chip').textContent(), /高清/);
    await page.locator('#categoryIncludeSearch').click();
    const list = page.locator('#categoryIncludeSuggestions');
    const total = await page.evaluate(() => CategoryLibrary.options().length);
    const count = await list.locator('[role=option]').count();
    check('all categories can be browsed without searching', () => assert.equal(count, total));
    const metrics = await list.evaluate(el => ({ height: el.clientHeight, full: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    check('category list has bounded scrolling', () => assert.ok(metrics.full > metrics.height && /auto|scroll/.test(metrics.overflow), JSON.stringify(metrics)));
    // A popup can lose focus to browser chrome while the menu stays open.
    await page.locator('#categoryIncludeSearch').evaluate(el => el.blur());
    const overlap = await page.evaluate(() => {
      const list = document.querySelector('#categoryIncludeSuggestions');
      const label = document.querySelector('.exclude-picker .category-picker-label');
      const r = label.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + 20, r.y + r.height / 2);
      return list.contains(el);
    });
    check('open menu covers underlying labels even after focus loss', () => assert.equal(overlap, true));
    fs.mkdirSync(path.join(root, 'output', 'playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output', 'playwright', 'category-picker.png'), fullPage: true });
    await page.locator('#categoryIncludeSearch').fill('高清');
    const labels = await list.locator('strong').allTextContents();
    check('Chinese search offers one translated category', () => assert.equal(labels.filter(s => s === '高清').length, 1));
    const translated = await page.evaluate(() => CategoryLibrary.options().find(o => o.rule === CategoryLibrary.valueRule('ハイビジョン'))?.label);
    check('Japanese metadata has a Chinese display name', () => assert.equal(translated, '高清'));
    await page.locator('#categoryIncludeSearch').fill('不存在的分类XYZ');
    const unmatchedCount = await list.locator('[role=option]').count();
    check('unmatched search shows no unrelated choices', () => assert.equal(unmatchedCount, 0));
    for (const mode of ['Include', 'Exclude']) {
      const input = page.locator(`#category${mode}Search`);
      const menu = page.locator(`#category${mode}Suggestions`);
      await input.fill('');
      await input.focus();
      const lastLabel = await menu.locator('strong').last().textContent();
      await menu.scrollIntoViewIfNeeded();
      const box = await menu.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(id => {
        const el = document.getElementById(id);
        return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      }, `category${mode}Suggestions`);
      await menu.locator('[role=option]').last().click();
      assert.ok((await page.locator(`#category${mode}Field .selected-category-chip`).allTextContents()).some(text => text.includes(lastLabel)));
      assert.equal(await menu.isHidden(), true);
      assert.ok(await page.evaluate(mode => window.saved[`category${mode}Rules`].length > 0, mode));
      console.log(`PASS wheel scroll reaches and selects last ${mode.toLowerCase()} category`);
    }
    assert.deepEqual(errors, []);
    if (failures.length) throw new Error(failures.join('\n'));
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
