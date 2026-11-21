// Regression checks for reused cards, stalled page requests and imported links.
// Neutral fixtures only: every request is fulfilled locally or aborted.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const origin = 'https://fixture.example.test';
const card = (id, badge = 'ordinary') => `<div data-id="${id}"><div class="thumbnail"><a href="/cn/${id}">Fixture ${id}</a><span class="bottom-1 left-1">${badge}</span></div></div>`;
const markup = (cards, next = '') => `<!doctype html><meta charset="utf-8"><style>.hidden{display:none}.grid{display:grid;gap:8px}.thumbnail{padding:12px}</style><nav><a href="/cn/genres">Categories</a><a href="/cn/actresses">People</a></nav><div class="grid">${cards}</div>${next ? `<a rel="next" href="${next}">Next</a>` : ''}`;
const nextHtml = markup(card('sample-003') + card('sample-004'));
const isHidden = (page, id) => page.locator(`[data-id="${id}"]`).evaluate(el => el.classList.contains('missav-content-filter-hidden'));
const only = process.argv[2];

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const errors = [];
  async function fixture({ html = markup(card('sample-001') + card('sample-002')), mode = 'ready', responseHtml = nextHtml } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/cn/new') return route.fulfill({ contentType: 'text/html', body: html });
      return route.abort();
    });
    await page.goto(`${origin}/cn/new`);
    await page.addStyleTag({ path: path.join(root, 'content.css') });
    await page.evaluate(({ mode, responseHtml }) => {
      window.fixtureSettings = { settingsStorage: 'local', enabled: true, homepageEnabled: true, infiniteScroll: false,
        blockedPresets: ['uncensored'], genreIncludeRules: [], genreExcludeRules: [],
        actressLimitEnabled: false, showActressNames: false };
      window.fixtureMetrics = { callbacks: 0, fetches: 0 };
      const Observer = window.MutationObserver;
      window.MutationObserver = class extends Observer {
        constructor(callback) { super((mutations, observer) => { fixtureMetrics.callbacks++; callback(mutations, observer); }); }
      };
      const listeners = [];
      window.chrome = { runtime: { sendMessage() { throw new Error('metadata must not be queried for this host'); } },
        storage: { local: { get(keys, callback) {
          callback(Object.fromEntries(keys.filter(key => Object.hasOwn(fixtureSettings, key)).map(key => [key, structuredClone(fixtureSettings[key])])));
        } }, onChanged: { addListener(listener) { listeners.push(listener); } } } };
      window.changeFixtureSettings = changes => {
        Object.assign(fixtureSettings, changes);
        const event = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { newValue: value }]));
        for (const listener of listeners) listener(event, 'local');
      };
      window.fetchMode = mode;
      window.fetch = async (_url, options = {}) => {
        fixtureMetrics.fetches++;
        window.lastPageSignal = options.signal ?? null;
        const response = { ok: true, url: _url, text: async () => responseHtml };
        if (fetchMode === 'chain') {
          // Every following page holds only hidden cards and links one page further.
          const n = fixtureMetrics.fetches;
          const cards = `<div><div class="thumbnail"><a href="/cn/chain-${n}">Chain</a><span class="bottom-1 left-1">uncensored</span></div></div>`;
          return { ok: true, url: _url, text: async () => `<!doctype html><nav><a href="/cn/genres">C</a><a href="/cn/actresses">P</a></nav><div class="grid">${cards}</div><a rel="next" href="/cn/archive/page${n + 2}">Next</a>` };
        }
        if (fetchMode === 'connection') return new Promise(resolve => { window.releaseFetch = () => resolve(response); });
        if (fetchMode === 'body') return { ok: true, url: _url, text: () => new Promise(resolve => { window.releaseFetch = () => resolve(responseHtml); }) };
        return response;
      };
    }, { mode, responseHtml });
    for (const script of ['site-library.js', 'label-library.js', 'genre-library.js', 'settings.js', 'metadata-client.js', 'content.js']) {
      await page.addScriptTag({ path: path.join(root, script) });
    }
    await page.waitForSelector('[data-viewing-assistant]', { state: 'attached' });
    return page;
  }
  try {
    if (!only || only === 'reuse') {
      // The site reuses a card node and only swaps its link or badge state.
      const page = await fixture();
      await page.locator('[data-id="sample-001"] a').evaluate(el => { el.href = '/cn/sample-001-uncensored-leak'; });
      await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'), null, { timeout: 2000 });
      await page.locator('[data-id="sample-001"] a').evaluate(el => { el.href = '/cn/sample-001'; });
      await page.waitForFunction(() => !document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'), null, { timeout: 2000 });
      for (const attribute of ['class', 'hidden']) {
        await page.locator('[data-id="sample-001"] span').evaluate((el, attribute) => {
          el.textContent = 'uncensored';
          if (attribute === 'class') el.classList.add('hidden');
          if (attribute === 'hidden') el.hidden = true;
        }, attribute);
        await page.waitForTimeout(50);
        assert.equal(await isHidden(page, 'sample-001'), false, `${attribute} hides the badge, so the card stays`);
        await page.locator('[data-id="sample-001"] span').evaluate((el, attribute) => {
          if (attribute === 'class') el.classList.remove('hidden');
          if (attribute === 'hidden') el.hidden = false;
        }, attribute);
        await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('missav-content-filter-hidden'), null, { timeout: 2000 });
      }
      await page.waitForTimeout(1000); // Past the delayed load scan.
      const callbacks = await page.evaluate(() => fixtureMetrics.callbacks);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => fixtureMetrics.callbacks), callbacks, 'own class writes settle without a feedback loop');
      await page.close();
      console.log('PASS reused cards are re-checked on link, class and hidden changes');
    }
    if (!only || only === 'stall') {
      for (const mode of ['connection', 'body']) {
        const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode });
        await page.waitForFunction(() => fixtureMetrics.fetches === 1);
        await page.waitForSelector('.missav-content-filter-retry', { timeout: 20000 });
        assert.equal(await page.evaluate(() => lastPageSignal?.aborted), true, 'the stalled request is aborted');
        await page.evaluate(() => { fetchMode = 'ready'; });
        await page.locator('.missav-content-filter-retry').click();
        await page.waitForSelector('[data-id="sample-003"]', { timeout: 5000 });
        assert.equal(await page.evaluate(() => fixtureMetrics.fetches), 2);
        await page.close();
        console.log(`PASS a stalled ${mode} times out and can be retried`);
      }
      const late = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode: 'body' });
      await late.waitForFunction(() => !!window.releaseFetch);
      await late.evaluate(() => { changeFixtureSettings({ enabled: false }); releaseFetch(); });
      await late.waitForTimeout(150);
      assert.equal(await late.evaluate(() => lastPageSignal?.aborted), true, 'pausing cancels the request');
      assert.equal(await late.locator('[data-missav-filter-refill]').count(), 0);
      await late.close();
      console.log('PASS pausing cancels a page request in flight');
    }
    if (!only || only === 'limit') {
      const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002', 'uncensored'), '/cn/archive/page2'), mode: 'chain' });
      await page.waitForSelector('.missav-content-filter-retry', { timeout: 5000 });
      assert.match(await page.locator('.missav-content-filter-retry').innerText(), /已往后查找 8 页.*继续查找/);
      assert.equal(await page.evaluate(() => fixtureMetrics.fetches), 8);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => fixtureMetrics.fetches), 8, 'stops at the limit until asked');
      await page.locator('.missav-content-filter-retry').click();
      await page.waitForFunction(() => fixtureMetrics.fetches === 16, null, { timeout: 5000 });
      await page.close();
      console.log('PASS an empty page explains the page limit and continues on request');
    }
    if (!only || only === 'import') {
      const relative = markup(`<div><div class="thumbnail"><a href="../sample-002">Duplicate</a><span class="bottom-1 left-1">ordinary</span></div></div><div data-id="sample-003"><div class="thumbnail"><a href="../sample-003">Relative</a><span class="bottom-1 left-1">ordinary</span><img data-src="./cover.svg" data-srcset="../small.svg 1x, ./large.svg 2x"><a class="unsafe" href="javascript:alert(1)">Unsafe</a></div></div>`);
      const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), responseHtml: relative });
      await page.waitForSelector('[data-id="sample-003"]', { timeout: 5000 });
      assert.equal(await page.locator('[data-id="sample-003"] a').first().getAttribute('href'), `${origin}/cn/sample-003`);
      assert.equal(await page.locator('[data-id="sample-003"] img').getAttribute('src'), `${origin}/cn/archive/cover.svg`);
      assert.equal(await page.locator('[data-id="sample-003"] img').getAttribute('srcset'), `${origin}/cn/small.svg 1x, ${origin}/cn/archive/large.svg 2x`);
      assert.equal(await page.locator('.unsafe').getAttribute('href'), null);
      assert.equal(await page.locator('[data-missav-filter-refill]').count(), 1, 'the duplicate of a native card is skipped');
      await page.close();
      console.log('PASS imported cards resolve links against the page they came from');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
