// End-to-end validation of the unpacked extension on isolated, local .test pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const out = path.join(root, 'output', 'template-browser');
fs.mkdirSync(out, { recursive: true });
const card = (i, badge = true, host = '') => `<div class="card"><div class="thumbnail"><a href="${host}/cn/demo-${i}">Sample ${i}</a>
  ${badge ? `<span class="bottom-1 left-1" ${i % 2 ? 'style="display:none"' : ''}>中文字幕</span>` : ''}</div></div>`;
const markup = ({ count = 12, badge = true, host = '', nav = true, more = false, next = false, offset = 0 } = {}) => `<!doctype html><meta charset="utf-8">
<style>.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.card{padding:10px;min-height:50px}body{margin:12px}</style>
${nav ? '<nav><a href="/cn/genres">Genres</a><a href="/cn/actresses">Actors</a></nav>' : ''}
<main><div class="grid" id="grid">${Array.from({ length: count }, (_, i) => card(i + offset, badge, host)).join('')}</div>
${more ? '<button id="more" @click.prevent="loadMore(0)">Load more</button>' : ''}
${next ? '<a rel="next" href="?page=2">Next</a>' : ''}</main>`;
const visibleCount = page => page.locator('.card').evaluateAll(cards => cards.filter(card => getComputedStyle(card).display !== 'none').length);
(async () => {
  const profile = fs.mkdtempSync(path.join(out, 'profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 900, height: 650 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  });
  try {
    const errors = [];
    let metadataRequests = 0;
    let nextRequests = 0;
    context.on("request", request => { if (request.url().includes("recombee.com")) metadataRequests += 1; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname.includes('recombee.com')) { return route.abort(); }
      if (!url.hostname.endsWith('.test')) return route.abort();
      let body;
      if (url.hostname === 'ordinary.test') body = '<!doctype html><h1>MISSAV</h1><p>Uncensored English subtitle</p>';
      else if (url.hostname === 'partial.test') body = markup({ badge: false });
      else if (url.hostname === 'external-cards.test') body = markup({ host: 'https://elsewhere.test' });
      else if (url.hostname === 'delayed.test') body = '<!doctype html><div id="root"></div>';
      else if (url.hostname === 'late-links.test') body = markup().replace(/href="\/cn\/demo-\d+"/g, 'href="#"');
      else if (url.hostname === 'one-result.test') body = markup({ count: 1 });
      else if (url.pathname === '/cn') {
        body = markup({ more: true }) + `<script>window.clicks=0; more.addEventListener('click',()=>{clicks++; grid.insertAdjacentHTML('beforeend',${JSON.stringify(Array.from({ length: 4 }, (_, i) => card(i + 20)).join(''))});});</script>`;
      } else if (url.searchParams.get('page') === '2') {
        nextRequests += 1;
        body = markup({ offset: 20 });
      } else body = markup({ next: true });
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, homepageEnabled: true,
      blockedPresets: ['chinese-subtitle'], hideUntagged: false, infiniteScroll: false,
      genreIncludeRules: ['value:impossible'], genreExcludeRules: ['value:blocked'] }));
    const open = async url => {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      return page;
    };
    for (const host of ['ordinary.test', 'partial.test', 'external-cards.test']) {
      const page = await open(`https://${host}/cn/new`);
      await page.waitForTimeout(200);
      assert.equal(await page.locator('[data-viewing-assistant]').count(), 0, host);
      assert.equal(await page.locator('.missav-content-filter-hidden').count(), 0, host);
      await page.close();
    }
    const single = await open('https://one-result.test/cn/search?q=sample');
    await single.waitForSelector('.missav-content-filter-hidden', { state: 'attached', timeout: 5000 });
    await single.close();
    const home = await open('https://compatible.test/cn');
    await home.waitForFunction(() => window.clicks === 1 &&
      !document.querySelector('.missav-content-filter-grid-settling'), null, { timeout: 10000 });
    assert.equal(await visibleCount(home), 8);
    const status = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'viewing-assistant-status' });
    });
    assert.equal(status.compatible, true);
    assert.equal(status.metadata, null);
    assert.equal(status.pageKind, 'home');
    assert.equal(await home.locator('.missav-content-filter-pending').count(), 0);
    await home.close();
    const paginated = await open('https://compatible.test/cn/new');
    await paginated.waitForFunction(() => document.querySelectorAll('[data-missav-filter-refill]').length === 6);
    assert.equal(await visibleCount(paginated), 12);
    assert.equal(nextRequests, 1);
    await paginated.close();
    await worker.evaluate(() => chrome.storage.sync.set({ infiniteScroll: true }));
    const infinite = await open('https://another-template.test/cn/new');
    await infinite.waitForFunction(() => document.querySelector('.missav-content-filter-sentinel')?.classList.contains('is-complete'));
    assert.equal(await visibleCount(infinite), 12);
    assert.equal(nextRequests, 2);
    await infinite.close();
    const lateLinks = await open('https://late-links.test/cn/new');
    await lateLinks.waitForTimeout(250);
    assert.equal(await lateLinks.locator('[data-viewing-assistant]').count(), 0);
    await lateLinks.locator('.thumbnail a').evaluateAll(links => links.forEach((link, i) => link.href = `/cn/demo-${i}`));
    await lateLinks.waitForSelector('[data-viewing-assistant]', { timeout: 1500 });
    assert.equal(await visibleCount(lateLinks), 6);
    await lateLinks.close();
    const delayed = await open('https://delayed.test/cn/new');
    assert.equal(await delayed.locator('[data-viewing-assistant]').count(), 0);
    await delayed.locator('#root').evaluate((root, html) => { root.innerHTML = html; }, markup());
    await delayed.waitForSelector('[data-viewing-assistant]');
    assert.equal(await visibleCount(delayed), 6);
    await delayed.locator('#grid').evaluate((grid, html) => grid.insertAdjacentHTML('beforeend', html), card(100));
    await delayed.waitForFunction(() => getComputedStyle(grid.lastElementChild).display === 'none');
    await delayed.close();
    assert.equal(metadataRequests, 0, '未知站点不得访问原站分类库');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ extension: 'loaded', positiveSites: 5, negativeSites: 3,
      homepage: 8, paginated: 12, infinite: 12, delayedActivation: 'passed', metadataRequests, errors }));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
