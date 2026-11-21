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
  for (const file of ["text.js", "label-library.js", "category-library.js", "settings.js"]) vm.runInContext(read(file), context);
  return { settings: context.SettingsStore, local: storage.local.state, sync: storage.sync.state, calls };
}

const load = (harness) => new Promise((resolve) => harness.settings.load(resolve));

test("1.0 版同步区的设置首次读取时按新名称复制到本机，同步区原样保留", async () => {
  const harness = createSettings({ sync: { enabled: false, maxActresses: 5, genreExcludeRules: [], blockedPresets: ["chinese-subtitle"] } });
  const loaded = await load(harness);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.maxActresses, 5);
  assert.deepEqual(Array.from(loaded.categoryExcludeRules), []);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["chinese-subtitle"]);
  assert.deepEqual(Array.from(harness.local.hiddenLabels), ["chinese-subtitle"]);
  assert.equal(harness.local.settingsVersion, 2);
  assert.equal(harness.sync.maxActresses, 5, "其他设备的旧版本仍依赖这份副本，不自动删除");
  assert.deepEqual(harness.sync.genreExcludeRules, []);
});

test("已是当前版本时只读本机，不再读取或写入同步区", async () => {
  const harness = createSettings({ local: { settingsVersion: 2, enabled: true }, sync: { enabled: false } });
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

test("本机旧名称的设置改用新名称，旧键和旧标记删除，不再读同步区", async () => {
  const harness = createSettings({
    local: { settingsStorage: "local", blockedPresets: ["other-subtitle"], genreIncludeRules: ["value:VR"], enabled: false },
    sync: { enabled: true, blockedPresets: ["uncensored"] }
  });
  const loaded = await load(harness);
  assert.equal(loaded.enabled, false);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["other-subtitle"]);
  assert.deepEqual(Array.from(harness.local.categoryIncludeRules), ["value:VR"]);
  for (const key of ["settingsStorage", "blockedPresets", "genreIncludeRules"]) {
    assert.equal(Object.hasOwn(harness.local, key), false, key);
  }
  assert.equal(harness.calls.some((call) => call.startsWith("sync.")), false);
});

test("只有早期版本能存的值在迁移时换成现在的写法", async () => {
  const harness = createSettings({ sync: {
    blockedPresets: ["english-subtitle"],
    genreIncludeRules: [`value:${encodeURIComponent("4小時以上")}`],
    genreExcludeRules: [`value:${encodeURIComponent("4時間以上作品")}`]
  } });
  const loaded = await load(harness);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["other-subtitle"]);
  assert.deepEqual(Array.from(loaded.categoryIncludeRules), ["group:duration-4h-plus"]);
  assert.deepEqual(Array.from(loaded.categoryExcludeRules), ["group:duration-4h-plus"]);
});

test("没有旧设置时使用默认值并记录版本", async () => {
  const harness = createSettings();
  const loaded = await load(harness);
  assert.equal(loaded.enabled, true);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["uncensored"]);
  assert.equal(harness.local.settingsVersion, 2);
});

test("同步区读不到时不记录版本，下次启动还会再试", async () => {
  const harness = createSettings({ sync: { enabled: false }, failures: { "sync.get": true } });
  assert.equal((await load(harness)).enabled, true);
  assert.equal(Object.hasOwn(harness.local, "settingsVersion"), false);
});

test("保存失败会把错误交给调用方", async () => {
  const harness = createSettings({ failures: { "local.set": true } });
  const error = await new Promise((resolve) => harness.settings.save(harness.settings.DEFAULTS, resolve));
  assert.ok(error);
});

test("账号中的旧副本只在用户删除时移除，且只删设置项", async () => {
  const harness = createSettings({ sync: { enabled: false, blockedPresets: [], unrelated: 1 } });
  assert.equal(await new Promise((resolve) => harness.settings.hasSyncCopy(resolve)), true);
  assert.equal(await new Promise((resolve) => harness.settings.removeSyncCopy(resolve)), null);
  assert.equal(Object.hasOwn(harness.sync, "enabled"), false);
  assert.equal(Object.hasOwn(harness.sync, "blockedPresets"), false, "旧名称的设置项一并删除");
  assert.equal(harness.sync.unrelated, 1);
  assert.equal(await new Promise((resolve) => harness.settings.hasSyncCopy(resolve)), false);
});

test("存储变化中只挑出设置项", () => {
  const { settings } = createSettings();
  assert.deepEqual(Array.from(settings.changedSettings({ "md:abc-001": {}, metadataCacheCount: {}, enabled: {} })), ["enabled"]);
});
