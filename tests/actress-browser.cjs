const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const out = path.join(root, 'output', 'actress-browser');
fs.mkdirSync(out, { recursive: true });
const fixtureNames = {
  'single-001': ['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬'],
  'three-001': ['松本いちか', '松本一香', '深田えいみ', '天海こころ', 'MIRU', '坂道みる'],
  'four-001': ['松本いちか', '深田えいみ', 'MIRU', '楓カレン'],
  'unknown-001': ['未收录甲', '未收录乙', '未收录丙', '未收录丁'],
  'empty-001': null,
  'long-001': ['用于验证封面边界的很长演员姓名ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
  'next-001': ['松本いちか'],
  'late-001': ['松本いちか'],
  'recover-single-001': ['皆月ひかる'],
  'recover-multi-001': ['皆月ひかる', '若月もあ']
};
const markup = (ids, next = false) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:20px;background:#10141c;color:#edf0f7;font:14px system-ui}
nav{margin-bottom:18px}nav a{color:#cbd5e1;margin-right:12px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;max-width:1380px}
.thumbnail{position:relative;overflow:hidden;border-radius:6px;background:#697e82}
.aspect-h-9{--tw-aspect-h:9}
.aspect-w-16{position:relative;padding-bottom:calc(var(--tw-aspect-h) / var(--tw-aspect-w) * 100%);--tw-aspect-w:16}
.aspect-w-16>*{position:absolute;height:100%;width:100%;top:0;right:0;bottom:0;left:0}
.thumbnail a{position:absolute;inset:0;color:transparent}
.thumbnail .bottom-1{position:absolute;top:auto;right:auto;height:auto;width:auto;bottom:4px;left:4px;background:#000b;color:white;font-size:12px;padding:2px 5px}
.title{margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:500px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}body{margin:10px}}
</style></head><body><nav><a href="/cn/genres">分类</a><a href="/cn/actresses">女优</a></nav>
<main><div class="grid">${ids.map(id => `<div class="card" data-id="${id}"><div class="thumbnail aspect-w-16 aspect-h-9"><a href="/cn/${id}" aria-label="Fixture ${id}"></a><span class="bottom-1 left-1">中文字幕</span></div><div class="title">测试卡片 ${id}</div></div>`).join('')}</div>
${next ? '<a rel="next" href="?page=2">下一页</a>' : ''}</main></body></html>`;
const visible = (page, id) => page.locator(`[data-id="${id}"]`).evaluate(el => getComputedStyle(el).display !== 'none');
const waitSettled = page => page.waitForFunction(() => !document.querySelector('.missav-content-filter-pending') &&
  !!document.querySelector('.missav-actress-names'));

(async () => {
  const profile = fs.mkdtempSync(path.join(out, 'profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  });
  try {
    const errors = [];
    const unexpectedRequests = [];
    const listIds = Object.keys(fixtureNames).slice(0, 6);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'missav.ai' || !['/cn/new', '/cn/refill', '/cn/late', '/cn/recovery', '/cn'].includes(url.pathname)) {
        unexpectedRequests.push(url.href);
        return route.abort();
      }
      let html;
      if (url.pathname === '/cn/recovery') html = markup(['single-001', 'three-001', 'recover-single-001', 'recover-multi-001', 'absent-001']);
      else if (url.pathname === '/cn/late') html = markup(['late-001']);
      else if (url.pathname === '/cn/refill') html = url.searchParams.get('page') === '2'
        ? markup(['next-001']) : markup(['single-001', 'four-001'], true);
      else html = markup(listIds);
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await worker.evaluate(async names => {
      globalThis.fixtureCalls = [];
      globalThis.pendingFixture = null;
      globalThis.delayFixture = false;
      globalThis.recoveryAttempts = 0;
      globalThis.recoveryMode = 'transport';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://client-rapi-missav.recombee.com/')) return originalFetch(url, options);
        const body = JSON.parse(options.body);
        fixtureCalls.push(body);
        if (body.requests.some(r => r.params.searchQuery.startsWith('recover-'))) {
          recoveryAttempts++;
          if (recoveryMode === 'permanent' || (recoveryMode === 'transport' && recoveryAttempts === 1)) {
            throw new Error('Temporary connection failure');
          }
        }
        if (delayFixture && body.requests.some(r => r.params.searchQuery === 'late-001')) {
          await new Promise(resolve => { pendingFixture = resolve; });
        }
        return new Response(JSON.stringify(body.requests.map(request =>
          request.params.searchQuery === 'absent-001' ? { code: 200, json: { recomms: [] } } :
          recoveryMode === 'partial' && recoveryAttempts === 1 && request.params.searchQuery === 'recover-multi-001'
            ? { code: 429, json: { message: 'Rate limited' } } :
          ({ code: 200, json: { recomms: [{
          id: request.params.searchQuery,
          values: { genres: [], tags: [], type: 'jav', duration: 7200,
            actresses: names[request.params.searchQuery], actresses_count: 99 }
        }] } }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      await chrome.storage.sync.set({ enabled: true, homepageEnabled: true,
        blockedPresets: [], genreIncludeRules: [], genreExcludeRules: [],
        actressLimitEnabled: true, maxActresses: 3, showActressNames: true, infiniteScroll: false });
      await chrome.storage.local.set({ videoMetadataById: {
        'single-001': { genres: [], tags: [], duration: 7200, type: 'jav' }
      } });
    }, fixtureNames);
    const settings = value => worker.evaluate(value => chrome.storage.sync.set(value), value);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://missav.ai/cn/new');
    await waitSettled(page);
    assert.equal(await visible(page, 'single-001'), true, 'five aliases are one person');
    assert.equal(await visible(page, 'three-001'), true, 'three is not greater than three');
    assert.equal(await visible(page, 'four-001'), false, 'four people exceed the default limit');
    assert.equal(await visible(page, 'unknown-001'), true, 'unknown aliases cannot prove four people');
    assert.equal(await visible(page, 'empty-001'), false, 'missing cast data cannot count as passing an enabled actress filter');
    assert.equal(await page.locator('[data-id="empty-001"]').evaluate(el => el.classList.contains('missav-content-filter-unverified')), true);
    assert.equal(await page.locator('[data-id="single-001"] .missav-actress-names').textContent(), '田中柠檬');
    assert.equal(await page.locator('[data-id="empty-001"] .missav-actress-names').count(), 0);
    assert.equal(await worker.evaluate(() => fixtureCalls.length), 1, 'one batch also refreshes old cache');
    assert.equal(await worker.evaluate(() => fixtureCalls[0].requests.every(r => r.params.includedProperties.includes('actresses'))), true);
    console.log('PASS batch lookup, old cache upgrade, aliases and strict person threshold');

    await settings({ actressLimitEnabled: false });
    await page.waitForFunction(() => !document.querySelector('[data-id="four-001"]').classList.contains('missav-content-filter-hidden'));
    assert.equal(await page.locator('[data-id="four-001"] .missav-actress-names').textContent(), '松本一香、深田咏美、坂道美琉…');
    for (const width of [1440, 900, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const results = await page.locator('.missav-actress-names').evaluateAll(overlays => overlays.map(el => {
        const host = el.parentElement.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const badge = el.parentElement.querySelector('.bottom-1');
        const style = getComputedStyle(el);
        return { inside: box.left >= host.left && box.right <= host.right + 0.1 && box.top >= host.top && box.bottom <= host.bottom + 0.1,
          oneLine: box.height <= parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 0.1,
          largeEnough: parseFloat(getComputedStyle(el).fontSize) >= 2 * parseFloat(getComputedStyle(badge).fontSize),
          ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' && getComputedStyle(el).overflow === 'hidden' };
      }));
      assert.ok(results.length > 0 && results.every(result => result.inside && result.oneLine && result.largeEnough && result.ellipsis), JSON.stringify({ width, results }));
      const long = page.locator('[data-id="long-001"] .missav-actress-names');
      assert.equal(await long.evaluate(el => el.scrollWidth > el.clientWidth), true, 'long text is actually clipped');
      await page.screenshot({ path: path.join(out, `names-${width}.png`), fullPage: true });
    }
    await settings({ showActressNames: false });
    await page.waitForFunction(() => !document.querySelector('.missav-actress-names'));
    assert.equal(await visible(page, 'four-001'), true);
    await settings({ actressLimitEnabled: true, maxActresses: 4 });
    await page.waitForTimeout(100);
    assert.equal(await visible(page, 'four-001'), true);
    await settings({ maxActresses: 2 });
    await page.waitForFunction(() => document.querySelector('[data-id="three-001"]').classList.contains('missav-content-filter-hidden'));
    assert.equal(await visible(page, 'single-001'), true);
    assert.equal(await worker.evaluate(() => fixtureCalls.length), 1, 'settings changes reuse resolved identities');
    console.log('PASS independent toggles, editable limit, Chinese names, top-three and bounded double-size text');

    await settings({ maxActresses: 3, showActressNames: true });
    const refill = await context.newPage();
    refill.on('pageerror', e => errors.push(e.message));
    await refill.goto('https://missav.ai/cn/refill');
    await refill.waitForSelector('[data-missav-filter-refill] .missav-actress-names');
    assert.equal(await refill.locator('[data-missav-filter-refill] .missav-actress-names').textContent(), '松本一香');
    assert.equal(await visible(refill, 'four-001'), false);
    await refill.close();
    console.log('PASS filtered page refills and imported covers receive actor names');

    await settings({ infiniteScroll: true });
    const infinite = await context.newPage();
    infinite.on('pageerror', e => errors.push(e.message));
    await infinite.goto('https://missav.ai/cn/refill');
    await infinite.waitForSelector('[data-missav-filter-refill] .missav-actress-names');
    await infinite.waitForFunction(() => document.querySelector('.missav-content-filter-sentinel')?.classList.contains('is-complete'));
    assert.equal(await infinite.locator('[data-missav-filter-refill] .missav-actress-names').textContent(), '松本一香');
    await infinite.close();
    await settings({ infiniteScroll: false });
    const home = await context.newPage();
    home.on('pageerror', e => errors.push(e.message));
    await home.goto('https://missav.ai/cn');
    await waitSettled(home);
    assert.equal(await visible(home, 'four-001'), false);
    await settings({ homepageEnabled: false });
    await home.waitForFunction(() => !document.querySelector('.missav-actress-names') && !document.querySelector('.missav-content-filter-hidden'));
    await home.close();
    await settings({ homepageEnabled: true });
    console.log('PASS actor names during infinite scrolling and homepage switch cleanup');

    const recovery = await context.newPage();
    await recovery.goto('https://missav.ai/cn/recovery');
    await recovery.waitForFunction(() =>
      document.querySelector('[data-id="recover-single-001"] .missav-actress-names')?.textContent === '皆月光' &&
      document.querySelector('[data-id="recover-multi-001"] .missav-actress-names')?.textContent === '皆月光、若月もあ',
      null, { timeout: 8000 });
    assert.equal(await worker.evaluate(() => recoveryAttempts), 2, 'transient failure retries once and then stops');
    await recovery.close();
    console.log('PASS previously cached names and both missing single/multi names recover without reload');

    for (const mode of ['partial', 'permanent']) {
      const start = await worker.evaluate(async mode => {
        recoveryMode = mode;
        recoveryAttempts = 0;
        const { videoMetadataById } = await chrome.storage.local.get('videoMetadataById');
        for (const id of ['recover-single-001', 'recover-multi-001']) delete videoMetadataById[id];
        await chrome.storage.local.set({ videoMetadataById });
        return fixtureCalls.length;
      }, mode);
      const retryPage = await context.newPage();
      await retryPage.goto('https://missav.ai/cn/recovery');
      await retryPage.waitForFunction(() => !document.querySelector('.missav-content-filter-pending'), null, { timeout: 8000 });
      if (mode === 'partial') {
        assert.equal(await retryPage.locator('[data-id="recover-multi-001"] .missav-actress-names').textContent(), '皆月光、若月もあ');
        assert.deepEqual(await worker.evaluate(start => fixtureCalls.slice(start).map(call => call.requests.map(r => r.params.searchQuery)), start),
          [['recover-single-001', 'recover-multi-001', 'absent-001'], ['recover-multi-001']],
          'only the failed item is retried; successful and explicit missing records are not');
      } else {
        assert.equal(await worker.evaluate(() => recoveryAttempts), 3, 'persistent errors have a retry limit');
        assert.equal(await visible(retryPage, 'recover-single-001'), false, 'failed lookup stays outside verified filter results');
        assert.equal(await retryPage.locator('.missav-content-filter-retry').count(), 1, 'failed lookup has an explicit retry control');
        assert.equal(await retryPage.locator('[data-id="recover-single-001"] .missav-actress-names').count(), 0, 'no invented name');
        await worker.evaluate(() => { recoveryMode = 'healthy'; });
        await retryPage.evaluate(() => window.dispatchEvent(new Event('online')));
        await retryPage.waitForSelector('[data-id="recover-single-001"] .missav-actress-names');
        assert.equal(await worker.evaluate(() => recoveryAttempts), 4, 'network recovery retries exhausted failures');
      }
      await retryPage.close();
    }
    console.log('PASS partial API failure, true missing record, retry limit and online recovery');

    await settings({ actressLimitEnabled: false });
    await worker.evaluate(() => { delayFixture = true; });
    const late = await context.newPage();
    late.on('pageerror', e => errors.push(e.message));
    await late.goto('https://missav.ai/cn/late');
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pendingFixture) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Metadata fixture did not start');
    });
    assert.equal(await visible(late, 'late-001'), true, 'names-only mode never masks the card while loading');
    await settings({ showActressNames: false });
    await worker.evaluate(() => { pendingFixture(); pendingFixture = null; });
    await late.waitForTimeout(150);
    assert.equal(await late.locator('.missav-actress-names').count(), 0, 'late response cannot undo display switch');
    await late.close();
    await settings({ enabled: false });
    await page.waitForFunction(() => !document.querySelector('.missav-content-filter-hidden') && !document.querySelector('.missav-actress-names'));
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, [], 'no detail-page or external mapping requests at runtime');
    console.log('PASS display-only loading, stale response cancellation and global reset');
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
