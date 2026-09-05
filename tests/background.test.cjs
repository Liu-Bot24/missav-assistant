const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const librarySource = fs.readFileSync(path.join(__dirname, "..", "genre-library.js"), "utf8");

function createCacheHarness(initialCache = {}, options = {}) {
  const failures = options.fetchFailures ?? 0;
  let listener;
  let storageListener;
  const state = { videoMetadataById: initialCache, discoveredTypes: [] };
  const metrics = { fetches: 0, cacheReads: 0, cacheWrites: 0 };
  const context = vm.createContext({
    crypto: crypto.webcrypto, TextEncoder, Uint8Array, URL, console,
    fetch: async (_url, options) => {
      metrics.fetches += 1;
      if (metrics.fetches <= failures) throw new Error("fixture network failure");
      await new Promise(setImmediate);
      return { ok: true, json: async () => JSON.parse(options.body).requests.map((request) => ({
        code: 200, json: { recomms: [{ id: request.params.searchQuery,
          values: { genres: ["sample"], tags: [], type: "sample", duration: 15000 } }] }
      })) };
    },
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        onChanged: { addListener(fn) { storageListener = fn; } },
        local: {
          async get(defaults) {
            if ("videoMetadataById" in defaults) metrics.cacheReads += 1;
            return structuredClone({ ...defaults, ...state });
          },
          async set(value) {
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
  context.importScripts = () => vm.runInContext(librarySource, context);
  vm.runInContext(backgroundSource, context);
  return {
    metrics, state,
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
  const metadata = { genres: ["sample"], tags: [], type: "sample", duration: 15000 };
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
                { id: "pets-071", values: { genres: ["女装・男の娘"], tags: [], type: "jav", duration: 14438 } }
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
  context.importScripts = () => vm.runInContext(librarySource, context);
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
  const body = JSON.parse(request.options.body);
  assert.equal(body.requests.length, 2);
  assert.equal(body.requests.every((item) => item.method === "POST"), true);
  assert.equal(body.requests.every((item) => item.path === "/search/users/anonymous/items/"), true);
  assert.equal(body.requests.some((item) => "cascadeCreate" in item.params), false);
  assert.equal(body.requests.every((item) => item.params.count === 10), true);
  assert.equal(body.requests.every((item) => item.params.returnProperties === true), true);
  assert.equal(
    body.requests.every((item) => item.params.includedProperties.includes("duration")),
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
  assert.equal(localState.videoMetadataById["mida-737"].duration, null);
  assert.equal(localState.metadataCacheCount, 2);
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
