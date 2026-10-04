const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const failures = [];
  const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (e) { failures.push(`${name}: ${e.message}`); } };
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
    await page.route(/^https?:/, route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.saved = { genreExcludeRules: ['value:' + encodeURIComponent('ハイビジョン')] };
      window.chrome = { storage: {
        local: {
          get(keys, cb) { cb(Array.isArray(keys) ? { missavSettingsStorageMode: 'local', missavLocalSettings: window.saved } : { ...keys }); },
          set(value, cb) { if (value.missavLocalSettings) window.saved = structuredClone(value.missavLocalSettings); cb(); }
        }, sync: { get(_keys, cb) { cb({}); }, set() { throw new Error('Unexpected sync write'); } }
      } };
    });
    await page.goto(pathToFileURL(path.join(root, 'popup.html')).href);
    await page.waitForFunction(() => !document.querySelector("#settingsFields").disabled);
    assert.match(await page.locator('#genreExcludeField .selected-genre-chip').textContent(), /高清/);
    await page.locator('#genreIncludeSearch').click();
    const list = page.locator('#genreIncludeSuggestions');
    const total = await page.evaluate(() => MissavGenreLibrary.options().length);
    const count = await list.locator('[role=option]').count();
    check('all categories can be browsed without searching', () => assert.equal(count, total));
    const metrics = await list.evaluate(el => ({ height: el.clientHeight, full: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    check('category list has bounded scrolling', () => assert.ok(metrics.full > metrics.height && /auto|scroll/.test(metrics.overflow), JSON.stringify(metrics)));
    // A popup can lose focus to browser chrome while the menu stays open.
    await page.locator('#genreIncludeSearch').evaluate(el => el.blur());
    const overlap = await page.evaluate(() => {
      const list = document.querySelector('#genreIncludeSuggestions');
      const label = document.querySelector('.exclude-picker .genre-picker-label');
      const r = label.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + 20, r.y + r.height / 2);
      return list.contains(el);
    });
    check('open menu covers underlying labels even after focus loss', () => assert.equal(overlap, true));
    fs.mkdirSync(path.join(root, 'output', 'playwright'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output', 'playwright', 'genre-picker.png'), fullPage: true });
    await page.locator('#genreIncludeSearch').fill('高清');
    const labels = await list.locator('strong').allTextContents();
    check('Chinese search offers one translated category', () => assert.equal(labels.filter(s => s === '高清').length, 1));
    const translated = await page.evaluate(() => MissavGenreLibrary.options().find(o => o.rule === MissavGenreLibrary.valueRule('ハイビジョン'))?.label);
    check('Japanese metadata has a Chinese display name', () => assert.equal(translated, '高清'));
    await page.locator('#genreIncludeSearch').fill('不存在的分类XYZ');
    const unmatchedCount = await list.locator('[role=option]').count();
    check('unmatched search shows no unrelated choices', () => assert.equal(unmatchedCount, 0));
    for (const mode of ['Include', 'Exclude']) {
      const input = page.locator(`#genre${mode}Search`);
      const menu = page.locator(`#genre${mode}Suggestions`);
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
      }, `genre${mode}Suggestions`);
      await menu.locator('[role=option]').last().click();
      assert.ok((await page.locator(`#genre${mode}Field .selected-genre-chip`).allTextContents()).some(text => text.includes(lastLabel)));
      assert.equal(await menu.isHidden(), true);
      await page.waitForFunction(() => document.querySelector("#saveState").textContent.includes("已保存"));
      assert.ok(await page.evaluate(mode => window.saved[`genre${mode}Rules`].length > 0, mode));
      console.log(`PASS wheel scroll reaches and selects last ${mode.toLowerCase()} category`);
    }
    assert.deepEqual(errors, []);
    if (failures.length) throw new Error(failures.join('\n'));
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
