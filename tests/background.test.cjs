const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
function loadScripts(context, files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}

function createCacheHarness(initialCache = {}, options = {}) {
  const failures = options.fetchFailures ?? 0;
  let listener;
  let storageListener;
  const state = { videoMetadataById: initialCache, discoveredTypes: [] };
  const metrics = { fetches: 0, cacheReads: 0, cacheWrites: 0 };
  const context = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, Uint8Array, URL, console, AbortSignal,
    fetch: async (_url, requestOptions) => {
      metrics.fetches += 1;
      if (metrics.fetches <= failures) throw new Error("fixture network failure");
      await new Promise(setImmediate);
      if (options.deferFetch) await options.deferFetch();
      return { ok: true, json: async () => JSON.parse(requestOptions.body).requests.map((request) => ({
        code: 200, json: { recomms: [{ id: request.params.searchQuery,
          values: { genres: ["sample"], tags: [], type: "sample", duration: 15000,
            actresses: options.actresses ?? ["松本いちか", "松本一香"], ...options.values } }] }
      })) };
    },
    chrome: {
      runtime: { id: "fixture-extension", getURL: name => `chrome-extension://fixture-extension/${name}`, onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        onChanged: { addListener(fn) { storageListener = fn; } },
        local: {
          async get(defaults) {
            if ("videoMetadataById" in defaults) metrics.cacheReads += 1;
            return structuredClone({ ...defaults, ...state });
          },
          async set(value) {
            if (options.failWrites) throw new Error("fixture storage failure");
            if (value.videoMetadataById) metrics.cacheWrites += 1;
            Object.assign(state, structuredClone(value));
            storageListener?.(Object.fromEntries(Object.entries(value).map(([key, newValue]) =>
              [key, { newValue: structuredClone(newValue) }]
            )), "local");
          }
        }
      }
    }
  });
  context.importScripts = (...files) => loadScripts(context, files);
  vm.runInContext(backgroundSource, context);
  return {
    metrics, state,
    clearFromPopup() { return new Promise(resolve => listener({ type: "missav-clear-metadata-cache" },
      { id: "fixture-extension", url: "chrome-extension://fixture-extension/popup.html" }, resolve)); },
    message(value, sender, respond) { return listener(value, sender, respond); },
    query(ids) { return new Promise((resolve) => listener(
      { type: "missav-query-metadata", itemIds: ids },
      { tab: { url: "https://missav.ai/new" } }, resolve
    )); },
    clear() {
      state.videoMetadataById = {};
      storageListener?.({ videoMetadataById: { newValue: {} } }, "local");
    }
  };
}

test("性能：多个页面同时查询重叠番号只发出一次在途查询", async () => {
  const harness = createCacheHarness();
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    harness.query(["sample-001", "sample-002"])
  ));
  for (const response of responses) {
    assert.equal(response.ok, true);
    assert.equal(response.items["sample-002"].duration, 15000);
  }
  console.log(JSON.stringify({ scenario: "overlapping-tabs", ...harness.metrics }));
  assert.equal(harness.metrics.fetches, 1);
  assert.equal(harness.metrics.cacheWrites, 1);
  await harness.query(["sample-003"]);
  assert.equal(harness.metrics.fetches, 2, "不同番号仍必须查询");
});

test("性能：热缓存不重复读取整份五千条映射，清空后会重新查询", async () => {
  const metadata = { genres: ["sample"], tags: [], type: "sample", duration: 15000, actresses: ["松本いちか"], cachedAt: Date.now() };
  const cache = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`sample-${i}`, metadata]));
  const harness = createCacheHarness(cache);
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await harness.query([`sample-${i}`])).items[`sample-${i}`].duration, 15000);
  }
  console.log(JSON.stringify({ scenario: "warm-cache", ...harness.metrics }));
  assert.equal(harness.metrics.fetches, 0);
  assert.equal(harness.metrics.cacheReads, 1);
  harness.clear();
  await harness.query(["sample-0"]);
  assert.equal(harness.metrics.fetches, 1, "外部缓存变化不能留下过期内存映射");
});

test("合并查询失败后释放在途项，下一次请求可以恢复", async () => {
  const harness = createCacheHarness({}, { fetchFailures: 1 });
  const failed = await Promise.all(Array.from({ length: 3 }, () => harness.query(["sample-001"])));
  assert.ok(failed.every((response) => response.ok === false));
  const recovered = await harness.query(["sample-001"]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.items["sample-001"].duration, 15000);
  assert.equal(harness.metrics.fetches, 2);
});

test("旧缓存补齐女优数据后按人物去重，新缓存不重复请求", async () => {
  const old = { genres: ['sample'], tags: [], type: 'sample', duration: 15000 };
  const harness = createCacheHarness({ 'sample-001': old }, {
    actresses: ['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬']
  });
  const first = await harness.query(['sample-001']);
  assert.equal(harness.metrics.fetches, 1, '旧记录缺少 actresses，必须实际补齐');
  assert.equal(first.items['sample-001'].actresses.length, 5);
  assert.equal(first.items['sample-001'].cast.confirmedCount, 1);
  assert.equal(first.items['sample-001'].cast.names[0], '田中柠檬');
  assert.equal(harness.state.videoMetadataById['sample-001'].actresses.length, 5);
  const cached = await harness.query(['sample-001']);
  assert.equal(cached.items['sample-001'].cast.confirmedCount, 1);
  assert.equal(harness.metrics.fetches, 1);
});

test("资料缺失不伪装成空分类或零时长，也不作为完整缓存阻断重试", async () => {
  const values = { genres: null, duration: null, actresses: null };
  const harness = createCacheHarness({}, { values });
  const first = (await harness.query(['partial-001'])).items['partial-001'];
  assert.equal(first.genres, null);
  assert.equal(first.duration, null);
  assert.equal(first.actresses, null);
  assert.equal(harness.state.videoMetadataById['partial-001'], undefined);
  Object.assign(values, { genres: [], duration: 7000, actresses: [] });
  const recovered = (await harness.query(['partial-001'])).items['partial-001'];
  assert.equal(recovered.genres.length, 0, '明确的空数组仍然是有效资料');
  assert.equal(recovered.actresses.length, 0);
  await harness.query(['partial-001']);
  assert.equal(harness.metrics.fetches, 2, '完整结果继续复用缓存');
});

test("部分重叠的并发查询分别返回完整结果，持久缓存合并不丢项", async () => {
  const harness = createCacheHarness();
  const [first, second] = await Promise.all([
    harness.query(["sample-001", "sample-002"]),
    harness.query(["sample-002", "sample-003"])
  ]);
  assert.deepEqual(Object.keys(first.items).sort(), ["sample-001", "sample-002"]);
  assert.deepEqual(Object.keys(second.items).sort(), ["sample-002", "sample-003"]);
  assert.equal(harness.metrics.fetches, 2);
  assert.equal(harness.state.metadataCacheCount, 3);
  const restarted = createCacheHarness(harness.state.videoMetadataById);
  assert.equal((await restarted.query(["sample-003"])).items["sample-003"].duration, 15000);
  assert.equal(restarted.metrics.fetches, 0, "后台重启后仍复用持久缓存");
});

test("后台用一个只读 Batch 查询多个 item，并只返回精确 ID", async () => {
  let messageListener;
  let request;
  let fetchCount = 0;
  let savedTypes;
  const localState = { discoveredTypes: [] };
  const context = vm.createContext({
    crypto: crypto.webcrypto,
    AbortSignal,
    TextEncoder,
    Uint8Array,
    URL,
    console,
    fetch: async (url, options) => {
      fetchCount += 1;
      request = { url, options };
      return {
        ok: true,
        json: async () => [
          {
            code: 200,
            json: {
              recomms: [
                { id: "pets-071-other", values: { genres: ["wrong"] } },
                { id: "pets-071", values: { genres: ["女装・男の娘"], tags: [], type: "jav", duration: 14438, actresses: [] } }
              ]
            }
          },
          {
            code: 200,
            json: {
              recomms: [
                { id: "mida-737", values: { genres: ["単体作品"], tags: [], type: "jav" } }
              ]
            }
          }
        ]
      };
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        }
      },
      storage: {
        local: {
          async get(defaults) {
            return { ...defaults, ...localState };
          },
          async set(value) {
            Object.assign(localState, value);
            if (value.discoveredTypes) savedTypes = value.discoveredTypes;
          }
        }
      }
    }
  });
  context.importScripts = (...files) => loadScripts(context, files);
  vm.runInContext(backgroundSource, context);

  const response = await new Promise((resolve) => {
    const pending = messageListener(
      { type: "missav-query-metadata", itemIds: ["PETS-071", "MIDA-737"] },
      { tab: { url: "https://missav.ai/new" } },
      resolve
    );
    assert.equal(pending, true);
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.items).sort(), ["mida-737", "pets-071"]);
  assert.deepEqual(Array.from(response.items["pets-071"].genres), ["女装・男の娘"]);
  assert.equal(response.items["pets-071"].duration, 14438);
  assert.equal(response.items["pets-071"].cast.confirmedCount, 0);
  assert.equal(response.items["pets-071"].cast.complete, true);
  assert.equal(response.items["mida-737"].cast.complete, false);
  const body = JSON.parse(request.options.body);
  assert.equal(body.requests.length, 2);
  assert.equal(body.requests.every((item) => item.method === "POST"), true);
  assert.equal(body.requests.every((item) => item.path === "/search/users/anonymous/items/"), true);
  assert.equal(body.requests.some((item) => "cascadeCreate" in item.params), false);
  assert.equal(body.requests.every((item) => item.params.count === 10), true);
  assert.equal(body.requests.every((item) => item.params.returnProperties === true), true);
  assert.equal(
    body.requests.every((item) => item.params.includedProperties.includes("duration") &&
      item.params.includedProperties.includes("actresses") &&
      !item.params.includedProperties.includes("actresses_count")),
    true
  );
  assert.deepEqual(
    Array.from(savedTypes).sort(),
    ["単体作品", "女装・男の娘", "jav"].sort()
  );

  const cachedResponse = await new Promise((resolve) => {
    messageListener(
      { type: "missav-query-metadata", itemIds: ["PETS-071"] },
      { tab: { url: "https://missav.ai/new" } },
      resolve
    );
  });

  assert.equal(cachedResponse.ok, true);
  assert.equal(cachedResponse.items["pets-071"].duration, 14438);
  assert.equal(fetchCount, 1);
  assert.equal(localState.videoMetadataById["pets-071"].duration, 14438);
  assert.equal(response.items["mida-737"].duration, null);
  assert.equal(localState.videoMetadataById["mida-737"], undefined);
  assert.equal(localState.metadataCacheCount, 1);
});


test("未适配域名不能调用原站分类库，包括名称相似的域名", () => {
  const harness = createCacheHarness();
  for (const url of ["https://compatible.test/new", "https://missav.ai.other.test/new", "invalid-url"]) {
    const accepted = harness.message({ type: "missav-query-metadata", itemIds: ["sample-001"] },
      { url, tab: {} }, () => assert.fail("不应返回分类结果"));
    assert.equal(accepted, false, url);
  }
  assert.equal(harness.metrics.fetches, 0);
});


test("MA-06 expired complete cache refreshes and never silently falls back while offline", async () => {
  const old = { genres: [], tags: [], type: "sample", duration: 1, actresses: [], cachedAt: 0 };
  const fresh = createCacheHarness({ "sample-001": old });
  assert.equal((await fresh.query(["sample-001"])).items["sample-001"].duration, 15000);
  assert.equal(fresh.metrics.fetches, 1);
  const offline = createCacheHarness({ "sample-001": old }, { fetchFailures: 1 });
  assert.equal((await offline.query(["sample-001"])).ok, false);
});


test("MA-06 fresh timestamps hit while missing, future, and seven-day-old timestamps refresh", async () => {
  const metadata = { genres: [], tags: [], type: "sample", duration: 1, actresses: [] };
  for (const [timestamp, fetches] of [[Date.now(), 0], [undefined, 1], [Date.now() + 86400000, 1], [Date.now() - 7 * 86400000, 1]]) {
    const harness = createCacheHarness({ "sample-001": { ...metadata, cachedAt: timestamp } });
    await harness.query(["sample-001"]);
    assert.equal(harness.metrics.fetches, fetches, String(timestamp));
  }
});

test("MA-06 clearing caches prevents late requests from restoring cached records or discoveries", async () => {
  let release;
  const harness = createCacheHarness({}, { deferFetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = harness.query(["sample-001"]);
  while (!release) await new Promise(setImmediate);
  assert.equal((await harness.clearFromPopup()).ok, true);
  release();
  assert.deepEqual(Object.keys((await pending).items), []);
  await new Promise(setImmediate);
  assert.deepEqual(harness.state.videoMetadataById, {});
  assert.deepEqual(harness.state.discoveredTypes, []);
  assert.equal(harness.state.metadataCacheCount, 0);
});

test("MA-06 external clear invalidates in-flight work; page senders cannot clear caches", async () => {
  let release;
  const harness = createCacheHarness({}, { deferFetch: () => new Promise(resolve => { release = resolve; }) });
  const pending = harness.query(["sample-001"]);
  while (!release) await new Promise(setImmediate);
  harness.clear(); release();
  await pending;
  assert.deepEqual(harness.state.videoMetadataById, {});
  for (const sender of [{ tab: { url: "https://missav.ai/new" } }, { id: "fixture-extension", url: "chrome-extension://fixture-extension/popup.html", tab: {} }]) {
    assert.equal(harness.message({ type: "missav-clear-metadata-cache" }, sender, () => assert.fail("untrusted clear")), false);
  }
  assert.equal((await createCacheHarness({}, { failWrites: true }).clearFromPopup()).ok, false);
});

test("MA-06 cache pruning retains at most 5000 fresh records", async () => {
  const metadata = { genres: [], tags: [], type: "sample", duration: 1, actresses: [], cachedAt: Date.now() };
  const cache = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`sample-${i}`, metadata]));
  cache.old = { ...metadata, cachedAt: 1 };
  const harness = createCacheHarness(cache);
  await harness.query(["sample-new"]);
  assert.equal(Object.keys(harness.state.videoMetadataById).length, 5000);
  assert.equal(harness.state.metadataCacheCount, 5000);
  assert.equal(harness.state.videoMetadataById.old, undefined);
  assert.ok(harness.state.videoMetadataById["sample-new"]);
});
