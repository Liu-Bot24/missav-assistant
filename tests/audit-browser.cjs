// Neutral fixtures only. Every page/resource request is fulfilled locally or
// aborted, and pagination is a mock; no real website or account is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const origin = 'https://fixture.example.test';
const card = (id, badge = 'ordinary', extra = '') => `<div data-id="${id}"><div class="thumbnail"><a href="/cn/${id}">Fixture ${id}</a><span class="bottom-1 left-1">${badge}</span>${extra}</div></div>`;
const markup = (cards, next = '') => `<!doctype html><meta charset="utf-8"><style>.hidden{display:none}.grid{display:grid;gap:8px}.thumbnail{background:#ddd;padding:12px}</style><nav><a href="/cn/genres">Categories</a><a href="/cn/actresses">People</a></nav><div class="grid">${cards}</div>${next ? `<a rel="next" href="${next}">Next</a>` : ''}`;
const nextHtml = markup(card('sample-003') + card('sample-004'));
const hidden = (page, id) => page.locator(`[data-id="${id}"]`).evaluate(el => el.classList.contains('missav-content-filter-hidden'));

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const errors = [];
  async function fixture({ html = markup(card('sample-001') + card('sample-002')), mode = 'ready', responseHtml = nextHtml, infinite = false } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path fill="#999" d="M0 0h8v8H0z"/></svg>' });
      if (url.pathname === '/cn/new') return route.fulfill({ contentType: 'text/html', body: html });
      return route.abort();
    });
    await page.goto(`${origin}/cn/new`);
    await page.addStyleTag({ path: path.join(root, 'content.css') });
    await page.evaluate(({ mode, responseHtml, infinite }) => {
      window.fixtureSettings = { enabled: true, homepageEnabled: true, infiniteScroll: infinite,
        blockedPresets: ['uncensored'], genreIncludeRules: [], genreExcludeRules: [],
        actressLimitEnabled: false, showActressNames: false };
      window.fixtureMetrics = { callbacks: 0, fetches: 0 };
      const Observer = window.MutationObserver;
      window.MutationObserver = class extends Observer {
        constructor(callback) { super((mutations, observer) => { fixtureMetrics.callbacks++; callback(mutations, observer); }); }
      };
      const listeners = [];
      window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() { throw new Error('Metadata must not be called for neutral host'); } },
        storage: { local: { get(_keys, callback) { callback({ missavSettingsStorageMode: 'local', missavLocalSettings: fixtureSettings }); } },
          onChanged: { addListener(listener) { listeners.push(listener); } } } };
      window.changeFixtureSettings = changes => {
        Object.assign(fixtureSettings, changes);
        for (const listener of listeners) listener({ missavLocalSettings: { newValue: fixtureSettings } }, 'local');
      };
      window.fetchMode = mode;
      window.fetch = async (_url, options) => {
        fixtureMetrics.fetches++;
        window.lastPageSignal = options.signal;
        const response = { ok: true, text: async () => responseHtml };
        if (fetchMode === 'connection') return new Promise(resolve => { window.releaseFetch = () => resolve(response); });
        if (fetchMode === 'body') return { ok: true, text: () => new Promise(resolve => { window.releaseFetch = () => resolve(responseHtml); }) };
        return response;
      };
    }, { mode, responseHtml, infinite });
    for (const script of ['site-library.js', 'label-library.js', 'genre-library.js', 'metadata-client.js', 'settings-storage.js', 'content.js']) {
      await page.addScriptTag({ path: path.join(root, script) });
    }
    await page.waitForSelector('[data-viewing-assistant]', { state: 'attached' });
    return page;
  }
  try {
    const page = await fixture();
    await page.locator('[data-id="sample-001"] a').evaluate(el => { el.href = '/cn/sample-001-uncensored-leak'; });
    await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'));
    await page.locator('[data-id="sample-001"] a').evaluate(el => { el.href = '/cn/sample-001'; });
    await page.waitForFunction(() => !document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'));
    for (const attribute of ['class', 'hidden', 'x-show']) {
      await page.locator('[data-id="sample-001"] span').evaluate((el, attribute) => {
        el.textContent = 'uncensored';
        if (attribute === 'class') el.classList.add('hidden');
        if (attribute === 'hidden') el.hidden = true;
        if (attribute === 'x-show') el.setAttribute('x-show', 'item.has_chinese_subtitle');
      }, attribute);
      await page.waitForTimeout(30);
      assert.equal(await hidden(page, 'sample-001'), false, attribute + ' suppresses badge');
      await page.locator('[data-id="sample-001"] span').evaluate((el, attribute) => {
        if (attribute === 'class') el.classList.remove('hidden');
        if (attribute === 'hidden') el.hidden = false;
        if (attribute === 'x-show') el.setAttribute('x-show', 'item.is_uncensored_leak');
      }, attribute);
      await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'));
    }
    await page.waitForTimeout(1000); // Includes the extension's one delayed load scan.
    const callbacks = await page.evaluate(() => fixtureMetrics.callbacks);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => fixtureMetrics.callbacks), callbacks, 'own class writes must settle without an observer feedback loop');
    fs.mkdirSync(path.join(root, 'output', 'audit-browser'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'output', 'audit-browser', 'neutral-dynamic-fixture.png') });
    await page.close();
    console.log('PASS MA-01 native MutationObserver href/class/hidden/x-show and feedback-loop checks');

    for (const mode of ['connection', 'body']) {
      const pending = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode });
      await pending.waitForFunction(() => fixtureMetrics.fetches === 1);
      await pending.waitForSelector('.missav-content-filter-retry', { timeout: 20000 });
      assert.equal(await pending.evaluate(() => lastPageSignal.aborted), true);
      await pending.evaluate(() => { fetchMode = 'ready'; });
      await pending.locator('.missav-content-filter-retry').click();
      await pending.waitForSelector('[data-id="sample-003"]');
      assert.equal(await pending.evaluate(() => fixtureMetrics.fetches), 2);
      await pending.close();
      console.log(`PASS MA-02 real 15-second ${mode} timeout and retry`);
    }
    const late = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode: 'body' });
    await late.waitForFunction(() => !!window.releaseFetch);
    await late.evaluate(() => { changeFixtureSettings({ enabled: false }); releaseFetch(); });
    await late.waitForTimeout(100);
    assert.equal(await late.evaluate(() => lastPageSignal.aborted), true);
    assert.equal(await late.locator('[data-missav-filter-refill]').count(), 0);
    await late.close();
    console.log('PASS MA-02 cancellation rejects late browser body completion');

    const relative = markup(`<div><div class="thumbnail"><a href="../sample-002">Duplicate</a><span class="bottom-1 left-1">ordinary</span></div></div><div data-id="sample-003"><div class="thumbnail"><a href="../sample-003">Relative</a><span class="bottom-1 left-1">ordinary</span><img data-src="./cover.svg" data-srcset="../small.svg 1x, ./large.svg 2x"><a class="unsafe" href="javascript:alert(1)">Unsafe</a></div></div>`);
    const imported = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), responseHtml: relative });
    await imported.waitForSelector('[data-id="sample-003"]');
    assert.equal(await imported.locator('[data-id="sample-003"] a').first().getAttribute('href'), `${origin}/cn/sample-003`);
    assert.equal(await imported.locator('[data-id="sample-003"] img').getAttribute('src'), `${origin}/cn/archive/cover.svg`);
    assert.equal(await imported.locator('[data-id="sample-003"] img').getAttribute('srcset'), `${origin}/cn/small.svg 1x, ${origin}/cn/archive/large.svg 2x`);
    assert.equal(await imported.locator('.unsafe').getAttribute('href'), null);
    assert.equal(await imported.locator('[data-missav-filter-refill]').count(), 1);
    await imported.close();
    console.log('PASS MA-03 native imported links/resources, protocol filtering, and deduplication');
    const { pathToFileURL } = require('node:url');
    async function popupFixture(legacy = false) {
      const popup = await browser.newPage({ viewport: { width: 380, height: 700 } });
      popup.on('pageerror', error => errors.push(error.message));
      popup.on('dialog', dialog => dialog.accept());
      await popup.route(/^https?:/, route => route.abort());
      await popup.addInitScript(({ legacy }) => {
        window.savedLocal = legacy ? {} : { missavSettingsStorageMode: 'local', missavLocalSettings: { enabled: true } };
        window.savedSync = legacy ? { enabled: false } : {};
        window.syncWrites = 0;
        window.failWrite = false;
        window.holdWrites = false;
        window.writeCallbacks = [];
        window.chrome = { runtime: {}, storage: {
          local: {
            get(keys, callback) { callback({ ...(Array.isArray(keys) ? {} : keys), ...savedLocal }); },
            set(value, callback) {
              const finish = () => {
                if (failWrite) { chrome.runtime.lastError = { message: 'fixture quota failure' }; callback(); delete chrome.runtime.lastError; }
                else { Object.assign(savedLocal, structuredClone(value)); callback(); }
              };
              if (holdWrites) writeCallbacks.push(finish); else finish();
            }
          },
          sync: {
            get(_keys, callback) { callback(structuredClone(savedSync)); },
            set(value, callback) { syncWrites++; Object.assign(savedSync, structuredClone(value)); callback(); }
          }, onChanged: { addListener() {} }
        } };
      }, { legacy });
      await popup.goto(pathToFileURL(path.join(root, 'popup.html')).href);
      return popup;
    }
    const failed = await popupFixture();
    await failed.waitForFunction(() => !document.querySelector('#settingsFields').disabled);
    await failed.evaluate(() => { failWrite = true; });
    await failed.locator('label.switch').filter({ has: failed.locator('#enabled') }).click();
    await failed.waitForFunction(() => document.querySelector('#saveState').textContent.startsWith('未保存'));
    assert.equal(await failed.evaluate(() => savedLocal.missavLocalSettings.enabled), true);
    await failed.evaluate(() => { failWrite = false; });
    await failed.locator('#retrySaveButton').click();
    await failed.waitForFunction(() => document.querySelector('#saveState').textContent.startsWith('已保存'));
    assert.equal(await failed.evaluate(() => savedLocal.missavLocalSettings.enabled), false);
    await failed.evaluate(() => { holdWrites = true; });
    await failed.locator('label.switch').filter({ has: failed.locator('#enabled') }).click();
    await failed.waitForFunction(() => writeCallbacks.length === 1);
    await failed.locator('label.switch').filter({ has: failed.locator('#enabled') }).click();
    await failed.evaluate(() => writeCallbacks.shift()());
    await failed.waitForFunction(() => writeCallbacks.length === 1);
    assert.doesNotMatch(await failed.locator('#saveState').textContent(), /^已保存/);
    await failed.evaluate(() => writeCallbacks.shift()());
    await failed.waitForFunction(() => document.querySelector('#saveState').textContent.startsWith('已保存'));
    assert.equal(await failed.evaluate(() => savedLocal.missavLocalSettings.enabled), false);
    assert.equal(await failed.evaluate(() => syncWrites), 0);
    await failed.screenshot({ path: path.join(root, 'output', 'audit-browser', 'neutral-popup-local.png'), fullPage: true });
    await failed.close();
    console.log('PASS MA-04 real popup failure, retry, serialized late callbacks, and truthful success');

    const migration = await popupFixture(true);
    await migration.waitForSelector('#copyToLocalButton');
    assert.equal(await migration.locator('#enabled').isDisabled(), true);
    assert.equal(await migration.evaluate(() => syncWrites), 0);
    await migration.locator('#copyToLocalButton').click();
    await migration.waitForFunction(() => !document.querySelector('#settingsFields').disabled);
    assert.equal(await migration.evaluate(() => savedLocal.missavSettingsStorageMode), 'local');
    assert.equal(await migration.evaluate(() => savedLocal.missavLocalSettings.enabled), false);
    assert.equal(await migration.evaluate(() => syncWrites), 0);
    await migration.locator('label.switch').filter({ has: migration.locator('#enabled') }).click();
    await migration.waitForFunction(() => document.querySelector('#saveState').textContent.startsWith('已保存'));
    await migration.locator('#storageOptionsButton').click();
    await migration.locator('#useSyncCopyButton').click();
    await migration.waitForFunction(() => savedLocal.missavSettingsStorageMode === 'sync');
    assert.equal(await migration.locator('#enabled').isChecked(), false);
    assert.equal(await migration.evaluate(() => syncWrites), 0, 'selecting existing sync cannot overwrite it');
    await migration.locator('label.switch').filter({ has: migration.locator('#enabled') }).click();
    await migration.waitForFunction(() => document.querySelector('#saveState').textContent.startsWith('已保存'));
    assert.equal(await migration.evaluate(() => savedSync.enabled), true);
    assert.equal(await migration.evaluate(() => syncWrites), 1);
    await migration.close();
    console.log('PASS MA-05 explicit migration, local default, preserved copies, and opt-in sync');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
