const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const out = path.join(root, 'output', 'pipeline-browser');

function markup(ids, next = null) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:20px;background:#10141c;color:white;font:14px system-ui}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;min-height:1500px;align-content:start}
    .thumbnail{position:relative}.cover{position:relative;aspect-ratio:16/9;background:#405166}
    .cover a{position:absolute;inset:0}.bottom-1{position:absolute;left:4px;bottom:4px;font-size:12px}
    .spacer{height:1800px}
    </style></head><body><nav><a href="/cn/actresses">女优</a><a href="/cn/genres">分类</a></nav>
    <div class="grid">${ids.map(id => `<div data-id="${id}"><div class="thumbnail"><div class="cover"><a href="/cn/${id}"></a><span class="bottom-1 left-1">中文字幕</span></div><div>${id}</div></div></div>`).join('')}</div>
    <div class="spacer"></div>${next ? `<a rel="next" href="?page=${next}">下一页</a>` : ''}</body></html>`;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(out, 'profile-')), {
    headless: true, viewport: { width: 1200, height: 700 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  });
  try {
    const errors = [];
    const pageRequests = [];
    let releaseOldPage;
    let oldPageWaiting = false;
    let staleRequests = 0;
    let invalidPageRequests = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'missav.ai') return route.abort();
      const pageNumber = Number(url.searchParams.get('page') || 1);
      pageRequests.push(`${url.pathname}:${pageNumber}`);
      let ids;
      let next;
      if (url.pathname === '/cn/async') {
        ids = Array.from({ length: 65 }, (_, index) => `async-${String(index).padStart(3, '0')}`);
      } else if (url.pathname === '/cn/incomplete') {
        ids = ['partial-genres-001', 'partial-actresses-001', 'partial-duration-001', 'empty-arrays-001'];
      } else if (url.pathname === '/cn/refill-retry') {
        ids = pageNumber === 1 ? ['refill-first-001', 'refill-blocked-001', 'refill-blocked-002']
          : pageNumber === 2 ? ['refill-fast-001', 'refill-failed-001'] : ['refill-third-001'];
        next = pageNumber < 3 ? pageNumber + 1 : null;
      } else if (url.pathname === '/cn/names-only') {
        ids = [pageNumber === 1 ? 'names-first-001' : pageNumber === 2 ? 'names-slow-001' : 'names-third-001'];
        next = pageNumber < 3 ? pageNumber + 1 : null;
      } else if (url.pathname === '/cn/html-retry') {
        ids = pageNumber === 1 ? ['html-first-001', 'html-blocked-001'] : ['html-recovery-001'];
        next = pageNumber === 1 ? 2 : null;
        if (pageNumber === 2 && ++invalidPageRequests === 1) {
          return route.fulfill({ contentType: 'text/html', body: '<html><body>Temporarily unavailable</body></html>' });
        }
      } else if (url.pathname === '/cn/stale') {
        ids = [`stale-${pageNumber}01`];
        next = pageNumber < 3 ? pageNumber + 1 : null;
        if (pageNumber === 2 && ++staleRequests === 1) {
          oldPageWaiting = true;
          await new Promise(resolve => { releaseOldPage = resolve; });
          return route.fulfill({ status: 503, body: 'Unavailable' });
        }
      } else {
        ids = pageNumber === 1 ? ['first-001'] : pageNumber === 2
          ? ['next-single-001', 'next-blocked-001', 'next-failed-001']
          : ['third-single-001', 'third-blocked-001'];
        next = pageNumber < 3 ? pageNumber + 1 : null;
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup(ids, next) });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      globalThis.requests = [];
      globalThis.failedIds = ['next-failed-001'];
      globalThis.holdId = null;
      globalThis.releaseMetadata = null;
      globalThis.incomplete = true;
      globalThis.fetch = async (_url, options) => {
        const batch = JSON.parse(options.body).requests;
        const ids = batch.map(r => r.params.searchQuery);
        requests.push(ids);
        if (ids.includes(holdId)) await new Promise(resolve => { releaseMetadata = resolve; });
        const valuesFor = id => ({
          genres: incomplete && id === 'partial-genres-001' ? null : id === 'empty-arrays-001' ? []
            : id.includes('blocked') || id === 'async-000' ? ['blocked'] : ['keep'],
          tags: [], type: 'jav', duration: incomplete && id === 'partial-duration-001' ? null : 7000,
          actresses: incomplete && id === 'partial-actresses-001' ? null : id === 'empty-arrays-001' ? [] : ['皆月ひかる']
        });
        return new Response(JSON.stringify(ids.map(id => failedIds.includes(id)
          ? { code: 429 } : { code: 200, json: { recomms: [{
          id, values: valuesFor(id)
        }] } })), { status: 200 });
      };
      await chrome.storage.sync.set({ enabled: true, homepageEnabled: true, infiniteScroll: true,
        blockedPresets: [], genreIncludeRules: [], genreExcludeRules: ['value:blocked'],
        actressLimitEnabled: false, showActressNames: true });
    });
    const open = async url => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      return page;
    };
    const clickNext = page => page.locator('.missav-content-filter-sentinel').evaluate(el => el.click());
    const page = await open('https://missav.ai/cn/pipeline');
    await page.waitForSelector('[data-id="first-001"] .missav-actress-names');
    // The delayed load scan must be over before requesting the next page.
    await page.waitForTimeout(1000);
    await clickNext(page);
    await page.waitForSelector('[data-id="next-single-001"]');
    assert.equal(await page.locator('[data-id="next-single-001"] .missav-actress-names').count(), 1,
      'a newly appended card must keep its name without a later document rescan');
    assert.equal(await page.locator('[data-id="next-blocked-001"]').count(), 0,
      'a blocked classification from the next page must never be inserted');
    assert.equal(await page.locator('.missav-content-filter-sentinel.is-loading').count(), 1,
      'a successful card appears while another item is still retrying');
    assert.equal(await page.locator('[data-id="next-failed-001"]').count(), 0);
    await page.waitForSelector('.missav-content-filter-sentinel.is-error');
    assert.equal(pageRequests.includes('/cn/pipeline:3'), false, 'failed metadata must hold the page cursor');
    assert.match(await page.locator('.missav-content-filter-retry').innerText(), /1 部影片资料未能确认/);
    assert.deepEqual(await worker.evaluate(() => requests.slice(2)), [['next-failed-001'], ['next-failed-001']],
      'only the failed item is automatically retried');
    await worker.evaluate(() => { failedIds = []; });
    await clickNext(page);
    await page.waitForSelector('[data-id="next-failed-001"] .missav-actress-names');
    assert.equal(await page.locator('[data-id="next-single-001"]').count(), 1, 'retry cannot duplicate successful cards');
    assert.equal(pageRequests.filter(key => key === '/cn/pipeline:2').length, 1, 'retry reuses the same fetched page');
    await page.waitForFunction(() => !document.querySelector('.missav-content-filter-sentinel.is-loading'));
    await clickNext(page);
    await page.waitForSelector('.missav-content-filter-sentinel.is-complete');
    assert.equal(await page.locator('[data-id="third-single-001"] .missav-actress-names').count(), 1);
    assert.equal(await page.locator('[data-id="third-blocked-001"]').count(), 0);
    await worker.evaluate(() => chrome.storage.sync.set({ showActressNames: false }));
    await page.waitForFunction(() => !document.querySelector('.missav-actress-names'));
    assert.equal(await page.locator('[data-missav-filter-refill]').count(), 3, 'names toggle preserves loaded pages');
    await worker.evaluate(() => chrome.storage.sync.set({ showActressNames: true }));
    await page.waitForFunction(() => document.querySelectorAll('.missav-actress-names').length === 4);
    assert.equal((await worker.evaluate(() => requests)).flat().filter(id => id === 'next-single-001').length, 1);
    await page.screenshot({ path: path.join(out, 'three-pages.png'), fullPage: false });
    await page.close();
    console.log('PASS pages 2/3 names, progressive results, failure cursor, retry deduplication and display toggle');

    await worker.evaluate(() => { holdId = 'async-030'; requests = []; });
    const asyncPage = await open('https://missav.ai/cn/async');
    await asyncPage.waitForSelector('[data-id="async-064"] .missav-actress-names');
    assert.equal(await asyncPage.locator('[data-id="async-030"].missav-content-filter-pending').count(), 1);
    assert.equal(await asyncPage.locator('[data-id="async-000"].missav-content-filter-genre-hidden').count(), 1);
    assert.equal(await asyncPage.locator('[data-id="async-001"]').isVisible(), true);
    assert.deepEqual(await worker.evaluate(() => requests.map(ids => ids.length)), [30, 30, 5]);
    await worker.evaluate(() => chrome.storage.sync.set({ showActressNames: false }));
    await asyncPage.waitForFunction(() => !document.querySelector('.missav-actress-names'));
    // New native DOM is handled even while a separate data batch remains pending.
    await asyncPage.locator('.grid').evaluate(grid => {
      const card = grid.querySelector('[data-id="async-001"]').cloneNode(true);
      card.setAttribute('data-id', 'new-native-001');
      card.querySelector('a').href = '/cn/async-000';
      grid.append(card);
    });
    await asyncPage.waitForSelector('[data-id="new-native-001"].missav-content-filter-hidden', { state: 'attached' });
    assert.equal(await asyncPage.locator('[data-id="new-native-001"]').isVisible(), false);
    await worker.evaluate(() => chrome.storage.sync.set({ genreExcludeRules: [] }));
    await asyncPage.waitForFunction(() => !document.querySelector('.missav-content-filter-hidden'));
    await worker.evaluate(() => { holdId = null; releaseMetadata(); });
    await asyncPage.waitForTimeout(100);
    assert.equal(await asyncPage.locator('.missav-content-filter-hidden').count(), 0,
      'late metadata must use the current filter rules');
    assert.equal(await asyncPage.locator('.missav-actress-names').count(), 0);
    await worker.evaluate(() => chrome.storage.sync.set({ genreExcludeRules: ['value:blocked'], showActressNames: true }));
    await asyncPage.waitForSelector('[data-id="async-030"] .missav-actress-names');
    assert.equal(await asyncPage.locator('[data-id="async-000"]').isVisible(), false);
    assert.equal(await worker.evaluate(() => requests.length), 3, 'rule and display changes reuse available metadata');
    await asyncPage.close();
    console.log('PASS independent 30/30/5 batches, native updates and current settings after a late response');

    const stale = await open('https://missav.ai/cn/stale');
    await stale.waitForSelector('[data-id="stale-101"] .missav-actress-names');
    await clickNext(stale);
    for (let i = 0; i < 40 && !oldPageWaiting; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(oldPageWaiting, true);
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
    await stale.waitForFunction(() => !document.querySelector('.missav-content-filter-sentinel'));
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: true }));
    await stale.waitForSelector('.missav-content-filter-sentinel');
    await clickNext(stale);
    await stale.waitForSelector('[data-id="stale-201"] .missav-actress-names');
    releaseOldPage();
    await stale.waitForTimeout(100);
    assert.equal(await stale.locator('.missav-content-filter-sentinel.is-error').count(), 0,
      'an obsolete HTML failure must not overwrite the new pagination state');
    await clickNext(stale);
    await stale.waitForSelector('.missav-content-filter-sentinel.is-complete');
    assert.equal(await stale.locator('[data-id="stale-301"] .missav-actress-names').count(), 1);
    await stale.close();
    console.log('PASS obsolete page request isolation after disable/re-enable');

    await worker.evaluate(() => chrome.storage.sync.set({ actressLimitEnabled: true,
      genreExcludeRules: ['value:blocked', 'group:duration-4h-plus'] }));
    const partial = await open('https://missav.ai/cn/incomplete');
    await partial.waitForSelector('.missav-content-filter-retry');
    assert.equal(await partial.locator('.missav-content-filter-unverified').count(), 3,
      'missing required fields are unverified, never a successful empty classification or zero duration');
    assert.equal(await partial.locator('[data-id="empty-arrays-001"]').isVisible(), true,
      'explicit empty arrays remain valid data');
    await worker.evaluate(() => { incomplete = false; });
    await partial.locator('.missav-content-filter-retry').evaluate(el => el.click());
    await partial.waitForFunction(() => !document.querySelector('.missav-content-filter-hidden'));
    assert.equal(await partial.locator('.missav-actress-names').count(), 3);
    assert.deepEqual(await worker.evaluate(() => requests.at(-1)),
      ['partial-genres-001', 'partial-actresses-001', 'partial-duration-001']);
    await partial.close();
    console.log('PASS required field absence, genuine empty arrays and fresh data on explicit retry');

    await worker.evaluate(async () => {
      failedIds = ['refill-failed-001'];
      await chrome.storage.sync.set({ infiniteScroll: false });
    });
    const refill = await open('https://missav.ai/cn/refill-retry');
    await refill.waitForSelector('[data-id="refill-fast-001"] .missav-actress-names');
    assert.equal(await refill.locator('[data-id="refill-failed-001"]').count(), 0);
    await refill.waitForSelector('.missav-content-filter-retry');
    assert.equal(pageRequests.includes('/cn/refill-retry:3'), false);
    await worker.evaluate(() => { failedIds = []; });
    await refill.locator('.missav-content-filter-retry').evaluate(el => el.click());
    await refill.waitForSelector('[data-id="refill-failed-001"] .missav-actress-names');
    assert.equal(await refill.locator('[data-id="refill-fast-001"]').count(), 1);
    assert.equal(await refill.locator('[data-missav-filter-refill]').count(), 2);
    assert.equal(pageRequests.includes('/cn/refill-retry:3'), false, 'stop when enough verified results fill the native page');
    await refill.close();
    console.log('PASS paginated refill shares progressive decisions, retries and target count');

    await worker.evaluate(async () => {
      holdId = 'names-slow-001';
      releaseMetadata = null;
      await chrome.storage.sync.set({ actressLimitEnabled: false, genreExcludeRules: [], infiniteScroll: true });
    });
    const namesOnly = await open('https://missav.ai/cn/names-only');
    await namesOnly.waitForSelector('[data-id="names-first-001"] .missav-actress-names');
    await clickNext(namesOnly);
    await namesOnly.waitForSelector('[data-id="names-slow-001"]');
    assert.equal(await namesOnly.locator('[data-id="names-slow-001"]').isVisible(), true);
    assert.equal(await namesOnly.locator('[data-id="names-slow-001"] .missav-actress-names').count(), 0);
    await namesOnly.waitForFunction(() => !document.querySelector('.missav-content-filter-sentinel.is-loading'));
    await clickNext(namesOnly);
    await namesOnly.waitForSelector('[data-id="names-third-001"] .missav-actress-names');
    await worker.evaluate(() => { holdId = null; releaseMetadata(); });
    await namesOnly.waitForSelector('[data-id="names-slow-001"] .missav-actress-names');
    assert.equal(await namesOnly.locator('.missav-content-filter-sentinel.is-complete').count(), 1);
    await namesOnly.close();
    console.log('PASS display-only names do not delay insertion or the next page');

    await worker.evaluate(() => chrome.storage.sync.set({ infiniteScroll: false, genreExcludeRules: ['value:blocked'] }));
    const htmlRetry = await open('https://missav.ai/cn/html-retry');
    await htmlRetry.waitForSelector('.missav-content-filter-retry');
    await htmlRetry.locator('.missav-content-filter-retry').evaluate(el => el.click());
    await htmlRetry.waitForSelector('[data-id="html-recovery-001"] .missav-actress-names', { timeout: 1500 });
    assert.equal(invalidPageRequests, 2, 'a successful HTTP response with invalid page content must be fetched again');
    await htmlRetry.close();
    assert.deepEqual(errors, []);
    console.log('PASS invalid HTML is not retained as a successful page cache entry');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
