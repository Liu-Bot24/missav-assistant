// Regression checks for reused cards, stalled page requests and imported links.
// Neutral fixtures only: every request is fulfilled locally or aborted.
const assert = require('node:assert/strict');
const path = require('node:path');
const { launch } = require('./browser.cjs');
const root = path.join(__dirname, '..');
const origin = 'https://fixture.example.test';
const card = (id, badge = 'ordinary') => `<div data-id="${id}"><div class="thumbnail"><a href="/cn/${id}">Fixture ${id}</a><span class="bottom-1 left-1">${badge}</span></div></div>`;
const markup = (cards, next = '') => `<!doctype html><meta charset="utf-8"><style>.hidden{display:none}.grid{display:grid;gap:8px}.thumbnail{padding:12px}</style><nav><a href="/cn/genres">Categories</a><a href="/cn/actresses">People</a></nav><div class="grid">${cards}</div>${next ? `<a rel="next" href="${next}">Next</a>` : ''}`;
const nextHtml = markup(card('sample-003') + card('sample-004'));
const isHidden = (page, id) => page.locator(`[data-id="${id}"]`).evaluate(el => el.classList.contains('viewing-assistant-hidden'));
const only = process.argv[2];

(async () => {
  const browser = await launch();
  const errors = [];
  async function fixture({ html = markup(card('sample-001') + card('sample-002')), mode = 'ready', responseHtml = nextHtml, settings = {} } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === '/cn/new') return route.fulfill({ contentType: 'text/html', body: html });
      return route.abort();
    });
    await page.goto(`${origin}/cn/new`);
    await page.addStyleTag({ path: path.join(root, 'content.css') });
    await page.evaluate(({ mode, responseHtml, settings }) => {
      window.fixtureSettings = { settingsVersion: 2, enabled: true, homepageEnabled: true, infiniteScroll: false,
        hiddenLabels: ['uncensored'], categoryIncludeRules: [], categoryExcludeRules: [],
        actressLimitEnabled: false, showActressNames: false, ...settings };
      window.fixtureMetrics = { callbacks: 0, fetches: 0, urls: [] };
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
        fixtureMetrics.urls.push(String(_url));
        window.lastPageSignal = options.signal ?? null;
        if (window.failFetchNumber === fixtureMetrics.fetches) return { ok: false, status: 503, url: _url, text: async () => '' };
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
    }, { mode, responseHtml, settings });
    for (const script of ['text.js', 'site-library.js', 'label-library.js', 'category-library.js', 'settings.js', 'metadata-client.js', 'content.js']) {
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
      await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('viewing-assistant-hidden'), null, { timeout: 2000 });
      await page.locator('[data-id="sample-001"] a').evaluate(el => { el.href = '/cn/sample-001'; });
      await page.waitForFunction(() => !document.querySelector('[data-id="sample-001"]').classList.contains('viewing-assistant-hidden'), null, { timeout: 2000 });
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
        await page.waitForFunction(() => document.querySelector('[data-id="sample-001"]').classList.contains('viewing-assistant-hidden'), null, { timeout: 2000 });
      }
      await page.waitForTimeout(1000); // Past the delayed load scan.
      const callbacks = await page.evaluate(() => fixtureMetrics.callbacks);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => fixtureMetrics.callbacks), callbacks, 'own class writes settle without a feedback loop');
      // The span stops being a badge, so its label no longer counts.
      await page.locator('[data-id="sample-001"] span').evaluate(el => el.classList.remove('bottom-1', 'left-1'));
      await page.waitForFunction(() => !document.querySelector('[data-id="sample-001"]').classList.contains('viewing-assistant-hidden'), null, { timeout: 500 });
      await page.close();
      console.log('PASS reused cards are re-checked on link, class, hidden and lost-badge changes');

      // One card whose badge sits in a sibling column of the same grid.
      const solo = await fixture({ html: markup(card('sample-001') + card('sample-002')) +
        '<div class="grid" id="solo"><div><div class="thumbnail"><a href="/cn/solo-001">Solo</a></div></div><div class="details"><span class="badge" hidden>uncensored</span></div></div>' });
      const gridHidden = () => solo.locator('#solo').evaluate(el => el.classList.contains('viewing-assistant-hidden'));
      await solo.waitForTimeout(1000); // Past the delayed load scan.
      assert.equal(await gridHidden(), false);
      await solo.locator('.details span').evaluate(el => { el.hidden = false; });
      await solo.waitForFunction(() => document.querySelector('#solo').classList.contains('viewing-assistant-hidden'), null, { timeout: 500 });
      await solo.close();
      console.log('PASS a badge in a sibling column of a single-card grid is re-checked');
    }
    if (!only || only === 'stall') {
      for (const mode of ['connection', 'body']) {
        const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode });
        await page.waitForFunction(() => fixtureMetrics.fetches === 1);
        await page.waitForSelector('.viewing-assistant-retry', { timeout: 20000 });
        assert.equal(await page.evaluate(() => lastPageSignal?.aborted), true, 'the stalled request is aborted');
        await page.evaluate(() => { fetchMode = 'ready'; });
        await page.locator('.viewing-assistant-retry').click();
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
      assert.equal(await late.locator('[data-viewing-assistant-refill]').count(), 0);
      await late.close();
      console.log('PASS pausing cancels a page request in flight');
    }
    if (!only || only === 'limit') {
      const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002', 'uncensored'), '/cn/archive/page2'), mode: 'chain' });
      await page.waitForSelector('.viewing-assistant-retry', { timeout: 5000 });
      assert.match(await page.locator('.viewing-assistant-retry').innerText(), /已往后查找 8 页.*继续查找/);
      assert.equal(await page.evaluate(() => fixtureMetrics.fetches), 8);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => fixtureMetrics.fetches), 8, 'stops at the limit until asked');
      await page.locator('.viewing-assistant-retry').click();
      await page.waitForFunction(() => fixtureMetrics.fetches === 16, null, { timeout: 5000 });
      await page.close();
      console.log('PASS an empty page explains the page limit and continues on request');

      // After continuing, a failed page is retried from where it failed.
      const failing = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002', 'uncensored'), '/cn/archive/page2'), mode: 'chain' });
      await failing.waitForSelector('.viewing-assistant-retry', { timeout: 5000 });
      await failing.evaluate(() => { window.failFetchNumber = 11; });
      await failing.locator('.viewing-assistant-retry').click();
      await failing.waitForFunction(() => fixtureMetrics.fetches === 11, null, { timeout: 5000 });
      await failing.waitForFunction(() => /未能加载/.test(document.querySelector('.viewing-assistant-retry')?.textContent ?? ''), null, { timeout: 5000 });
      await failing.locator('.viewing-assistant-retry').click();
      await failing.waitForFunction(() => fixtureMetrics.fetches >= 12, null, { timeout: 5000 });
      const urls = await failing.evaluate(() => fixtureMetrics.urls);
      assert.equal(urls[11], urls[10], 'the retry asks for the page that failed');
      await failing.close();
      console.log('PASS a failed page after continuing is retried from that page');

      // The site switches to another list without reloading the document.
      const spa = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002', 'uncensored'), '/cn/archive/page2'), mode: 'chain' });
      await spa.waitForSelector('.viewing-assistant-retry', { timeout: 5000 });
      await spa.evaluate(() => {
        fetchMode = 'ready';
        history.pushState(null, '', '/cn/other');
        document.querySelector('div.grid').innerHTML = `<div data-id="other-001"><div class="thumbnail"><a href="/cn/other-001">O</a><span class="bottom-1 left-1">uncensored</span></div></div><div data-id="other-002"><div class="thumbnail"><a href="/cn/other-002">O</a><span class="bottom-1 left-1">ordinary</span></div></div>`;
        document.querySelector('a[rel="next"]').setAttribute('href', '/cn/other/page2');
      });
      await spa.waitForSelector('[data-id="sample-003"]', { timeout: 5000 });
      const spaUrls = await spa.evaluate(() => fixtureMetrics.urls);
      assert.match(spaUrls.at(-1), /\/cn\/other\/page2$/, 'the new list continues from its own next page');
      assert.equal(await spa.locator('.viewing-assistant-retry').count(), 0, 'the old list notice is gone');
      await spa.close();
      console.log('PASS switching lists in the same document drops the old list work');

      // A list that needed nothing switches to one that needs a refill.
      const quiet = await fixture({ html: markup(card('sample-001') + card('sample-002')) });
      await quiet.waitForTimeout(1000); // Past the delayed load scan.
      await quiet.evaluate(() => {
        history.pushState(null, '', '/cn/other');
        document.querySelector('div.grid').innerHTML = `<div data-id="other-001"><div class="thumbnail"><a href="/cn/other-001">O</a><span class="bottom-1 left-1">uncensored</span></div></div><div data-id="other-002"><div class="thumbnail"><a href="/cn/other-002">O</a><span class="bottom-1 left-1">ordinary</span></div></div>`;
        document.body.insertAdjacentHTML('beforeend', '<a rel="next" href="/cn/other/page2">Next</a>');
      });
      await quiet.waitForSelector('[data-id="sample-003"]', { timeout: 3000 });
      await quiet.close();
      console.log('PASS a new list in the same document starts its own refill');

      // An anchor jump while the next page loads stays on the same list.
      const anchored = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), mode: 'connection' });
      await anchored.waitForFunction(() => !!window.releaseFetch);
      await anchored.evaluate(() => { location.hash = 'top'; releaseFetch(); });
      await anchored.waitForSelector('[data-id="sample-003"]', { timeout: 3000 });
      await anchored.close();
      console.log('PASS an anchor jump does not discard the page being loaded');
    }
    if (!only || only === 'import') {
      const relative = markup(`<div><div class="thumbnail"><a href="../sample-002">Duplicate</a><span class="bottom-1 left-1">ordinary</span></div></div><div data-id="sample-003"><div class="thumbnail"><a href="../sample-003">Relative</a><span class="bottom-1 left-1">ordinary</span><img data-src="./cover.svg" data-srcset="../small.svg 1x, ./large.svg 2x"><a class="unsafe" href="javascript:alert(1)">Unsafe</a></div></div>`);
      const page = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), responseHtml: relative });
      await page.waitForSelector('[data-id="sample-003"]', { timeout: 5000 });
      assert.equal(await page.locator('[data-id="sample-003"] a').first().getAttribute('href'), `${origin}/cn/sample-003`);
      assert.equal(await page.locator('[data-id="sample-003"] img').getAttribute('src'), `${origin}/cn/archive/cover.svg`);
      assert.equal(await page.locator('[data-id="sample-003"] img').getAttribute('srcset'), `${origin}/cn/small.svg 1x, ${origin}/cn/archive/large.svg 2x`);
      assert.equal(await page.locator('.unsafe').getAttribute('href'), null);
      assert.equal(await page.locator('[data-viewing-assistant-refill]').count(), 1, 'the duplicate of a native card is skipped');
      await page.close();
      console.log('PASS imported cards resolve links against the page they came from');

      // A source page whose base points to a media host: covers follow it, links stay on the site.
      const cdn = markup(`<div data-id="sample-007"><div class="thumbnail"><a href="${origin}/cn/sample-007">Cdn</a><span class="bottom-1 left-1">ordinary</span><img src="cover.svg"><a class="away" href="elsewhere">Away</a></div></div>`)
        .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="https://media.example.test/assets/">');
      const based = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2'), responseHtml: cdn });
      await based.waitForSelector('[data-id="sample-007"]', { timeout: 5000 });
      assert.equal(await based.locator('[data-id="sample-007"] img').getAttribute('src'), 'https://media.example.test/assets/cover.svg');
      assert.equal(await based.locator('[data-id="sample-007"] a').first().getAttribute('href'), `${origin}/cn/sample-007`);
      assert.equal(await based.locator('.away').getAttribute('href'), null, 'a link resolved off the site is dropped');
      await based.close();
      console.log('PASS imported covers follow a base on another host');

      // A relative next link under that base leaves the site, so paging stops there.
      const offsite = markup(card('sample-001', 'uncensored') + card('sample-008'), 'page3')
        .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="https://media.example.test/assets/">')
        .replace('href="/cn/sample-008"', `href="${origin}/cn/sample-008"`);
      const stops = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002', 'uncensored') + card('sample-009'), '/cn/archive/page2'), responseHtml: offsite });
      await stops.waitForSelector('[data-id="sample-008"]', { timeout: 5000 });
      await stops.waitForTimeout(500);
      assert.deepEqual(await stops.evaluate(() => fixtureMetrics.urls), [`${origin}/cn/archive/page2`], 'no request to a page the base does not point to');
      await stops.close();
      console.log('PASS a next link is resolved against the source base and must stay on the site');

      // The open page has its own base, so its first next link resolves against that too.
      const ownBase = await fixture({ html: markup(card('sample-001', 'uncensored') + card('sample-002'), 'page2')
        .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="/cn/archive/">') });
      await ownBase.waitForSelector('[data-id="sample-003"]', { timeout: 5000 });
      assert.deepEqual(await ownBase.evaluate(() => fixtureMetrics.urls), [`${origin}/cn/archive/page2`]);
      await ownBase.close();
      console.log("PASS the open page's next link follows its own base");

      // Under that base a relative card link names /cn/archive/…, so the next page's copy is a duplicate.
      const relCard = '<div data-id="sample-021"><div class="thumbnail"><a href="sample-021">Relative</a><span class="bottom-1 left-1">ordinary</span></div></div>';
      const dupNext = markup(`<div data-id="dup-021"><div class="thumbnail"><a href="${origin}/cn/archive/sample-021">Again</a><span class="bottom-1 left-1">ordinary</span></div></div>${card('sample-022')}`);
      const dedupe = await fixture({ html: markup(card('sample-001', 'uncensored') + relCard, 'page2')
        .replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="/cn/archive/">'), responseHtml: dupNext });
      await dedupe.waitForSelector('[data-id="sample-022"]', { timeout: 5000 });
      assert.equal(await dedupe.locator('[data-id="dup-021"]').count(), 0, 'a card already on the page is not added again');
      await dedupe.close();
      console.log("PASS cards on the open page are recognized through its base");

      // The page's CSS hides this badge; only the inserted card can show that.
      const styled = markup(`<div data-id="sample-005"><div class="thumbnail"><a href="/cn/sample-005">Styled</a><span class="bottom-1 left-1 gone">ordinary</span></div></div>${card('sample-006')}`)
        .replace('<style>', '<style>.gone{display:none}');
      const untagged = await fixture({
        html: markup(card('sample-001', 'uncensored') + card('sample-002'), '/cn/archive/page2').replace('<style>', '<style>.gone{display:none}'),
        responseHtml: styled, settings: { hideUntagged: true }
      });
      await untagged.waitForSelector('[data-id="sample-006"]', { timeout: 5000 });
      assert.equal(await isHidden(untagged, 'sample-005'), true, 'a badge hidden by the page leaves the card untagged');
      assert.equal(await isHidden(untagged, 'sample-006'), false, 'the next card fills the place');
      await untagged.close();
      console.log('PASS imported cards are judged with the page styles once inserted');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
