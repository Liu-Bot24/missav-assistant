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

// Mirrors the Promise form of chrome.storage.local, including key lists and null reads.
function createLocalArea(initial = {}) {
  const state = structuredClone(initial);
  const metrics = { reads: [], writes: [], fullReads: 0 };
  const copy = (key) => structuredClone(state[key]);
  const api = {
    async get(keys) {
      if (keys === null || keys === undefined) {
        metrics.fullReads += 1;
        return structuredClone(state);
      }
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) {
        metrics.reads.push([...keys]);
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, copy(key)]));
      }
      metrics.reads.push(Object.keys(keys));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) =>
        [key, Object.hasOwn(state, key) ? copy(key) : fallback]));
    },
    async set(value) {
      metrics.writes.push(Object.keys(value));
      Object.assign(state, structuredClone(value));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete state[key];
    },
    async getKeys() {
      return Object.keys(state);
    }
  };
  return { state, metrics, api };
}

const metadataKeys = (state) => Object.keys(state).filter((key) => key.startsWith("md:"));
const metadataWrites = (metrics) => metrics.writes.filter((keys) => keys.some((key) => key.startsWith("md:")));

function createCacheHarness(initialState = {}, options = {}) {
  const failures = options.fetchFailures ?? 0;
  let listener;
  const local = createLocalArea(initialState);
  const metrics = { fetches: 0 };
  const context = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, Uint8Array, URL, console, AbortSignal,
    fetch: async (_url, requestOptions) => {
      metrics.fetches += 1;
      if (metrics.fetches <= failures) throw new Error("fixture network failure");
      await new Promise(setImmediate);
      return { ok: true, json: async () => JSON.parse(requestOptions.body).requests.map((request) => ({
        code: 200, json: { recomms: [{ id: request.params.searchQuery,
          values: { genres: ["sample"], tags: [], type: "sample", duration: 15000,
            actresses: options.actresses ?? ["松本いちか", "松本一香"], ...options.values } }] }
      })) };
    },
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: local.api }
    }
  });
  context.importScripts = (...files) => loadScripts(context, files);
  vm.runInContext(backgroundSource, context);
  return {
    metrics, local, state: local.state,
    message(value, sender, respond) { return listener(value, sender, respond); },
    query(ids) { return new Promise((resolve) => listener(
      { type: "viewing-assistant-query-metadata", itemIds: ids },
      { tab: { url: "https://missav.ai/new" } }, resolve
    )); },
    async clear() {
      await local.api.remove(metadataKeys(local.state));
    }
  };
}

const sampleRecord = (cachedAt) => ({
  genres: ["sample"], tags: [], type: "sample", duration: 15000, actresses: ["松本いちか"], cachedAt
});
// Recent timestamps in insertion order, all within the refresh period.
const recent = (i) => Date.now() - 3_600_000 + i;
const perVideoCache = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`md:sample-${i}`, sampleRecord(recent(i))]));

test("性能：多个页面同时查询重叠番号只发出一次在途查询", async () => {
  const harness = createCacheHarness();
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    harness.query(["sample-001", "sample-002"])
  ));
  for (const response of responses) {
    assert.equal(response.ok, true);
    assert.equal(response.items["sample-002"].duration, 15000);
  }
  assert.equal(harness.metrics.fetches, 1);
  assert.equal(metadataWrites(harness.local.metrics).length, 1);
  await harness.query(["sample-003"]);
  assert.equal(harness.metrics.fetches, 2, "不同番号仍必须查询");
});

test("旧版整份缓存一次性迁移为逐片存储，之后每次只读取所查影片", async () => {
  const legacy = Object.fromEntries(Array.from({ length: 5000 }, (_, i) =>
    [`sample-${i}`, { ...sampleRecord(recent(i)), cast: { confirmedCount: 1 } }]));
  const harness = createCacheHarness({ videoMetadataById: legacy });
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await harness.query([`sample-${i}`])).items[`sample-${i}`].duration, 15000);
  }
  assert.equal(harness.metrics.fetches, 0, "迁移后的缓存继续命中");
  assert.equal(Object.hasOwn(harness.state, "videoMetadataById"), false, "旧的整份缓存已移除");
  assert.equal(metadataKeys(harness.state).length, 5000);
  assert.equal(Object.hasOwn(harness.state["md:sample-0"], "cast"), false, "可推算的女优统计不再存储");
  const cacheReads = harness.local.metrics.reads.filter((keys) => keys.every((key) => key.startsWith("md:")));
  assert.equal(cacheReads.filter((keys) => keys.length > 1).length, 1, "只有重建分类列表时一次性读取全部缓存");
  assert.equal(cacheReads.filter((keys) => keys.length === 1).length, 12, "每次查询只读取所查的影片");
  await harness.clear();
  await harness.query(["sample-0"]);
  assert.equal(harness.metrics.fetches, 1, "缓存被清空后重新查询");
});

test("写入只涉及新增影片，不重写已有的五千条缓存", async () => {
  const harness = createCacheHarness({ ...perVideoCache(5000), metadataCacheCount: 5000 });
  await harness.query(["new-001", "new-002"]);
  const writes = metadataWrites(harness.local.metrics);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].filter((key) => key.startsWith("md:")).sort(), ["md:new-001", "md:new-002"]);
  assert.equal(harness.local.metrics.fullReads, 0);
  assert.equal(Object.hasOwn(harness.state, "metadataCacheCount"), false, "旧版存储的缓存数量已移除");
});

test("新增超过余量后按缓存时间淘汰最旧记录，保留新查到的影片", async () => {
  const harness = createCacheHarness({ ...perVideoCache(5000), metadataCacheCount: 5000 });
  const fresh = Array.from({ length: 510 }, (_, i) => `fresh-${i}`);
  for (let offset = 0; offset < fresh.length; offset += 30) {
    await harness.query(fresh.slice(offset, offset + 30));
  }
  const keys = metadataKeys(harness.state);
  assert.equal(keys.length, 5000);
  assert.ok(fresh.every((id) => Object.hasOwn(harness.state, `md:${id}`)), "新记录全部保留");
  assert.equal(Object.hasOwn(harness.state, "md:sample-0"), false, "最旧记录被淘汰");
  assert.equal(Object.hasOwn(harness.state, "md:sample-509"), false);
  assert.equal(Object.hasOwn(harness.state, "md:sample-510"), true);
});

test("缓存超过一周或时间异常时重新查询并更新", async () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const harness = createCacheHarness({
    "md:old-001": { ...sampleRecord(Date.now() - week - 1000), duration: 1 },
    "md:future-001": { ...sampleRecord(Date.now() + week), duration: 1 },
    "md:fresh-001": { ...sampleRecord(Date.now() - week + 60_000), duration: 1 }
  });
  const response = await harness.query(["old-001", "future-001", "fresh-001"]);
  assert.equal(harness.metrics.fetches, 1);
  assert.equal(response.items["old-001"].duration, 15000, "过期记录用新数据");
  assert.equal(response.items["future-001"].duration, 15000);
  assert.equal(response.items["fresh-001"].duration, 1, "一周内的记录直接使用");
  assert.ok(Date.now() - harness.state["md:old-001"].cachedAt < 60_000, "刷新后重新计时");
  assert.equal(metadataKeys(harness.state).length, 3, "刷新不新增记录");
});

test("刷新失败时仍用过期记录，没有缓存的影片留给页面重试", async () => {
  const harness = createCacheHarness({
    "md:old-001": { ...sampleRecord(Date.now() - 8 * 24 * 60 * 60 * 1000), duration: 1 }
  }, { fetchFailures: 1 });
  const response = await harness.query(["old-001", "new-001"]);
  assert.equal(response.items["old-001"].duration, 1);
  assert.equal(Object.hasOwn(response.items, "new-001"), false);
});

test("合并查询失败后释放在途项，下一次请求可以恢复", async () => {
  const harness = createCacheHarness({}, { fetchFailures: 1 });
  const failed = await Promise.all(Array.from({ length: 3 }, () => harness.query(["sample-001"])));
  assert.ok(failed.every((response) => !Object.hasOwn(response.items, "sample-001")), "失败的影片不出现在结果里，页面会重试");
  const recovered = await harness.query(["sample-001"]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.items["sample-001"].duration, 15000);
  assert.equal(harness.metrics.fetches, 2);
});

test("旧缓存补齐女优数据后按人物去重，新缓存不重复请求", async () => {
  const old = { genres: ['sample'], tags: [], type: 'sample', duration: 15000 };
  const harness = createCacheHarness({ videoMetadataById: { 'sample-001': old } }, {
    actresses: ['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬']
  });
  const first = await harness.query(['sample-001']);
  assert.equal(harness.metrics.fetches, 1, '旧记录缺少 actresses，必须实际补齐');
  assert.equal(first.items['sample-001'].actresses.length, 5);
  assert.equal(first.items['sample-001'].cast.confirmedCount, 1);
  assert.equal(first.items['sample-001'].cast.names[0], '田中柠檬');
  assert.equal(harness.state['md:sample-001'].actresses.length, 5);
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
  assert.equal(harness.state['md:partial-001'], undefined);
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
  assert.equal(metadataKeys(harness.state).length, 3);
  const restarted = createCacheHarness(harness.state);
  assert.equal((await restarted.query(["sample-003"])).items["sample-003"].duration, 15000);
  assert.equal(restarted.metrics.fetches, 0, "后台重启后仍复用持久缓存");
});

test("后台用一个只读 Batch 查询多个 item，并只返回精确 ID", async () => {
  let messageListener;
  let request;
  let fetchCount = 0;
  const local = createLocalArea({ discoveredTypes: [] });
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
      storage: { local: local.api }
    }
  });
  context.importScripts = (...files) => loadScripts(context, files);
  vm.runInContext(backgroundSource, context);

  const response = await new Promise((resolve) => {
    const pending = messageListener(
      { type: "viewing-assistant-query-metadata", itemIds: ["PETS-071", "MIDA-737"] },
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
  assert.equal(body.requests.every((item) => item.params.count === 1), true, "每个番号只要排第一的结果");
  assert.equal(body.requests.every((item) => item.params.returnProperties === true), true);
  assert.equal(
    body.requests.every((item) => item.params.includedProperties.includes("duration") &&
      item.params.includedProperties.includes("actresses") &&
      !item.params.includedProperties.includes("actresses_count")),
    true
  );
  assert.deepEqual({ ...local.state.discoveredCategories }, { "単体作品": 1, "女装・男の娘": 1 },
    "分类列表只收 genres 和 tags，不收 type");
  assert.equal(Object.hasOwn(local.state, "discoveredTypes"), false, "旧的分类列表已移除");

  const cachedResponse = await new Promise((resolve) => {
    messageListener(
      { type: "viewing-assistant-query-metadata", itemIds: ["PETS-071"] },
      { tab: { url: "https://missav.ai/new" } },
      resolve
    );
  });

  assert.equal(cachedResponse.ok, true);
  assert.equal(cachedResponse.items["pets-071"].duration, 14438);
  assert.equal(fetchCount, 1);
  assert.equal(local.state["md:pets-071"].duration, 14438);
  assert.equal(response.items["mida-737"].duration, null);
  assert.equal(local.state["md:mida-737"], undefined);
  assert.equal(Object.hasOwn(local.state, "metadataCacheCount"), false, "缓存数量不写入存储");
});


test("旧分类列表按已缓存影片重建：按出现次数计数、合并不同写法、不含 type", async () => {
  const record = (genres) => ({ ...sampleRecord(recent(0)), genres, type: "fc2" });
  const harness = createCacheHarness({
    discoveredTypes: ["jav", "uncensored-leak", "旧分类"],
    "md:a-001": record(["3P・4P", "中出し"]),
    "md:a-002": record(["3P、4P", "3P/4P"]),
    "md:a-003": record(["中出し"])
  });
  await harness.query(["a-001"]);
  assert.deepEqual({ ...harness.state.discoveredCategories }, { "3P・4P": 2, "中出し": 2 });
  assert.equal(Object.hasOwn(harness.state, "discoveredTypes"), false);
});

test("分类列表满 500 项时淘汰最少出现的，常见分类保留", async () => {
  const common = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`常见-${i}`, 5]));
  const harness = createCacheHarness({ discoveredCategories: common }, { values: { genres: ["新出现"], tags: [] } });
  await harness.query(["n-001", "n-002"]);
  const counts = harness.state.discoveredCategories;
  assert.equal(Object.keys(counts).length, 500);
  assert.equal(counts["新出现"], undefined, "只出现两次的新分类不挤掉出现五次的");
  const rising = createCacheHarness({ discoveredCategories: { ...common, "常见-0": 1 } },
    { values: { genres: ["新出现"], tags: [] } });
  await rising.query(["n-001", "n-002"]);
  assert.equal(rising.state.discoveredCategories["新出现"], 2);
  assert.equal(rising.state.discoveredCategories["常见-0"], undefined);
});

test("未适配域名不能调用原站分类库，包括名称相似的域名", () => {
  const harness = createCacheHarness();
  for (const url of ["https://compatible.test/new", "https://missav.ai.other.test/new", "invalid-url"]) {
    const accepted = harness.message({ type: "viewing-assistant-query-metadata", itemIds: ["sample-001"] },
      { url, tab: {} }, () => assert.fail("不应返回分类结果"));
    assert.equal(accepted, false, url);
  }
  assert.equal(harness.metrics.fetches, 0);
});
