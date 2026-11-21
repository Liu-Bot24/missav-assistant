const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// Callback form of chrome.storage with runtime.lastError, as popup and pages use it.
function createSettings({ local = {}, sync = {}, failures = {} } = {}) {
  const runtime = { lastError: null };
  const calls = [];
  const area = (name, state) => {
    const respond = (operation, callback, value) => {
      calls.push(`${name}.${operation}`);
      runtime.lastError = failures[`${name}.${operation}`] ? { message: "fixture failure" } : null;
      callback?.(runtime.lastError ? undefined : value);
      runtime.lastError = null;
    };
    return {
      state,
      get(keys, callback) {
        const list = Array.isArray(keys) ? keys : Object.keys(keys);
        respond("get", callback, structuredClone(Object.fromEntries(list
          .filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]))));
      },
      set(value, callback) {
        if (!failures[`${name}.set`]) Object.assign(state, structuredClone(value));
        respond("set", callback);
      },
      remove(keys, callback) {
        if (!failures[`${name}.remove`]) for (const key of [].concat(keys)) delete state[key];
        respond("remove", callback);
      }
    };
  };
  const storage = { local: area("local", structuredClone(local)), sync: area("sync", structuredClone(sync)) };
  const context = vm.createContext({ chrome: { runtime, storage }, console });
  for (const file of ["label-library.js", "genre-library.js", "settings.js"]) vm.runInContext(read(file), context);
  return { settings: context.MissavSettings, local: storage.local.state, sync: storage.sync.state, calls };
}

const load = (harness) => new Promise((resolve) => harness.settings.load(resolve));

test("旧版同步设置首次读取时复制到本机，同步区原样保留", async () => {
  const harness = createSettings({ sync: { enabled: false, maxActresses: 5, genreExcludeRules: [] } });
  const loaded = await load(harness);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.maxActresses, 5);
  assert.deepEqual(Array.from(loaded.genreExcludeRules), []);
  assert.equal(harness.local.enabled, false);
  assert.equal(harness.local.settingsStorage, "local");
  assert.equal(harness.sync.maxActresses, 5, "其他设备的旧版本仍依赖这份副本，不自动删除");
});

test("迁移完成后只读本机，不再读取或写入同步区", async () => {
  const harness = createSettings({ local: { settingsStorage: "local", enabled: true }, sync: { enabled: false } });
  assert.equal((await load(harness)).enabled, true);
  await new Promise((resolve) => harness.settings.save({ ...harness.settings.DEFAULTS, hideUntagged: true }, resolve));
  assert.equal(harness.local.hideUntagged, true);
  assert.equal(harness.calls.some((call) => call.startsWith("sync.")), false);
  assert.equal(harness.sync.enabled, false);
});

test("迁移不覆盖本机已保存的设置", async () => {
  const harness = createSettings({ local: { infiniteScroll: true }, sync: { infiniteScroll: false, hideUntagged: true } });
  const loaded = await load(harness);
  assert.equal(loaded.infiniteScroll, true);
  assert.equal(loaded.hideUntagged, true);
});

test("没有旧设置时使用默认值并记录已迁移", async () => {
  const harness = createSettings();
  const loaded = await load(harness);
  assert.equal(loaded.enabled, true);
  assert.deepEqual(Array.from(loaded.blockedPresets), ["uncensored"]);
  assert.equal(harness.local.settingsStorage, "local");
});

test("同步区读不到时不标记迁移，下次启动还会再试", async () => {
  const harness = createSettings({ sync: { enabled: false }, failures: { "sync.get": true } });
  assert.equal((await load(harness)).enabled, true);
  assert.equal(Object.hasOwn(harness.local, "settingsStorage"), false);
});

test("保存失败会把错误交给调用方", async () => {
  const harness = createSettings({ failures: { "local.set": true } });
  const error = await new Promise((resolve) => harness.settings.save(harness.settings.DEFAULTS, resolve));
  assert.ok(error);
});

test("账号中的旧副本只在用户删除时移除，且只删设置项", async () => {
  const harness = createSettings({ sync: { enabled: false, unrelated: 1 } });
  assert.equal(await new Promise((resolve) => harness.settings.hasSyncCopy(resolve)), true);
  assert.equal(await new Promise((resolve) => harness.settings.removeSyncCopy(resolve)), null);
  assert.equal(Object.hasOwn(harness.sync, "enabled"), false);
  assert.equal(harness.sync.unrelated, 1);
  assert.equal(await new Promise((resolve) => harness.settings.hasSyncCopy(resolve)), false);
});

test("存储变化中只挑出设置项", () => {
  const { settings } = createSettings();
  assert.deepEqual(Array.from(settings.changedSettings({ "md:abc-001": {}, metadataCacheCount: {}, enabled: {} })), ["enabled"]);
});
