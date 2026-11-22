const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// Callback form of chrome.storage with runtime.lastError, as popup and pages use it.
function createSettings({ local = {}, sync = {}, failures = {}, hold = [] } = {}) {
  const runtime = { lastError: null };
  const calls = [];
  const held = [];
  const area = (name, state) => {
    const respond = (operation, callback, value) => {
      if (hold.includes(`${name}.${operation}`)) {
        held.push(() => { callback?.(value); });
        return;
      }
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
  return { settings: context.SettingsStore, local: storage.local.state, sync: storage.sync.state, calls,
    storage, release: () => held.shift()?.() };
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

test("本机旧名称的设置改用新名称，旧键和旧标记删除；本机值优先，只在同步区的设置也迁入", async () => {
  const harness = createSettings({
    local: { settingsStorage: "local", blockedPresets: ["other-subtitle"], genreIncludeRules: ["value:VR"], enabled: false },
    sync: { enabled: true, blockedPresets: ["uncensored"], maxActresses: 8 }
  });
  const loaded = await load(harness);
  assert.equal(loaded.enabled, false);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["other-subtitle"]);
  assert.equal(loaded.maxActresses, 8, "只在同步区的设置不因标记而丢失");
  assert.deepEqual(Array.from(harness.local.categoryIncludeRules), ["value:VR"]);
  for (const key of ["settingsStorage", "blockedPresets", "genreIncludeRules"]) {
    assert.equal(Object.hasOwn(harness.local, key), false, key);
  }
});

test("带标记时同步区读不到也完成迁移，因为那一版已复制过同步区", async () => {
  const harness = createSettings({
    local: { settingsStorage: "local", blockedPresets: ["other-subtitle"] },
    failures: { "sync.get": true }
  });
  assert.deepEqual(Array.from((await load(harness)).hiddenLabels), ["other-subtitle"]);
  assert.equal(harness.local.settingsVersion, 2);
});

test("迁移未完成时改一项设置，只保存这一项，旧设置下次仍能迁入", async () => {
  const first = createSettings({
    local: { blockedPresets: ["other-subtitle"] },
    sync: { maxActresses: 8 },
    failures: { "sync.get": true }
  });
  const loaded = await load(first);
  assert.deepEqual(Array.from(loaded.hiddenLabels), ["other-subtitle"], "本机旧值在迁移前也生效");
  assert.equal(await new Promise((resolve) => first.settings.save({ ...loaded, enabled: false }, resolve)), null);
  assert.deepEqual(Object.keys(first.local).sort(), ["blockedPresets", "enabled"], "不写默认值，也不记录版本");
  assert.equal(await new Promise((resolve) => first.settings.hasSyncCopy(resolve)), false, "迁移前不提供删除账号副本");

  const later = createSettings({ local: first.local, sync: { maxActresses: 8 } });
  const migrated = await load(later);
  assert.equal(migrated.enabled, false, "用户的改动保留");
  assert.deepEqual(Array.from(migrated.hiddenLabels), ["other-subtitle"]);
  assert.equal(migrated.maxActresses, 8);
  assert.equal(later.local.settingsVersion, 2);
});

test("两处同时迁移时，后完成的一处不覆盖先完成后用户保存的值", async () => {
  const harness = createSettings({ sync: { maxActresses: 8 }, hold: ["sync.get"] });
  const done = [];
  harness.settings.migrate((ok) => done.push(["first", ok]));
  harness.settings.migrate((ok) => done.push(["second", ok]));
  harness.release();
  assert.equal(harness.local.maxActresses, 8);
  assert.equal(harness.local.settingsVersion, 2);
  harness.storage.local.set({ maxActresses: 6 });
  harness.release();
  assert.equal(harness.local.maxActresses, 6, "用户刚保存的值不被旧快照覆盖");
  assert.deepEqual(done, [["first", true], ["second", true]]);
});

test("已是当前版本时迁移直接结束，不再读取同步区", async () => {
  const harness = createSettings({ local: { settingsVersion: 2, maxActresses: 6 }, sync: { maxActresses: 8 } });
  assert.equal(await new Promise((resolve) => harness.settings.migrate(resolve)), true);
  assert.equal(harness.local.maxActresses, 6);
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
  const harness = createSettings({ local: { settingsVersion: 2 }, failures: { "local.set": true } });
  await load(harness);
  const error = await new Promise((resolve) => harness.settings.save(harness.settings.DEFAULTS, resolve));
  assert.ok(error);
});

test("读取设置之前不保存，避免用默认值覆盖未迁移的设置", async () => {
  const harness = createSettings({ local: { blockedPresets: ["other-subtitle"] } });
  const error = await new Promise((resolve) => harness.settings.save({ ...harness.settings.DEFAULTS, enabled: false }, resolve));
  assert.ok(error);
  assert.deepEqual(Object.keys(harness.local), ["blockedPresets"]);
});

test("弹窗直接修改读到的设置对象再保存，迁移未完成时也能存下改动", async () => {
  const harness = createSettings({ local: { blockedPresets: ["other-subtitle"] }, failures: { "sync.get": true } });
  const loaded = await load(harness);
  loaded.enabled = false;
  assert.equal(await new Promise((resolve) => harness.settings.save(loaded, resolve)), null);
  assert.equal(harness.local.enabled, false);
});

test("账号中的旧副本只在用户删除时移除，且只删设置项", async () => {
  const harness = createSettings({ sync: { enabled: false, blockedPresets: [], unrelated: 1 } });
  await load(harness);
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

test("默认只开不需要查询资料的功能；已打开的查询类设置保持打开", async () => {
  const fresh = await load(createSettings({ local: { settingsVersion: 2 } }));
  assert.equal(fresh.actressLimitEnabled, false);
  assert.equal(fresh.showActressNames, false);
  assert.deepEqual([...fresh.categoryIncludeRules], []);
  assert.deepEqual([...fresh.categoryExcludeRules], []);
  assert.deepEqual([...fresh.hiddenLabels], ["uncensored"]);
  assert.equal(fresh.enabled, true);
  const kept = await load(createSettings({ local: { settingsVersion: 2, actressLimitEnabled: true,
    showActressNames: true, categoryExcludeRules: ["group:gender-diverse"] } }));
  assert.equal(kept.actressLimitEnabled, true);
  assert.equal(kept.showActressNames, true);
  assert.deepEqual([...kept.categoryExcludeRules], ["group:gender-diverse"]);
  const legacy = await load(createSettings({ sync: { actressLimitEnabled: true, showActressNames: true,
    genreExcludeRules: ["group:gender-diverse"] } }));
  assert.equal(legacy.actressLimitEnabled, true);
  assert.deepEqual([...legacy.categoryExcludeRules], ["group:gender-diverse"]);
});

test("从 1.2.0 以前的版本升级时，从未保存的查询类设置保持原来的默认", async () => {
  const installed = (local, details, sync = {}) => new Promise((resolve) => {
    const harness = createSettings({ local, sync });
    harness.settings.handleInstalled(details, () => resolve(harness));
  });
  const upgraded = await installed({ settingsVersion: 2, hideUntagged: true }, { reason: "update", previousVersion: "1.1.0" });
  let values = await load(upgraded);
  assert.equal(values.actressLimitEnabled, true);
  assert.equal(values.showActressNames, true);
  assert.deepEqual([...values.categoryExcludeRules], ["group:gender-diverse"]);
  assert.equal(values.hideUntagged, true);

  const explicit = await installed({ settingsVersion: 2, actressLimitEnabled: false, categoryExcludeRules: [] },
    { reason: "update", previousVersion: "1.1.0" });
  values = await load(explicit);
  assert.equal(values.actressLimitEnabled, false, "保存过的 false 不改");
  assert.deepEqual([...values.categoryExcludeRules], [], "保存过的空列表不改");
  assert.equal(values.showActressNames, true);

  const fromSync = await installed({}, { reason: "update", previousVersion: "1.0.2" }, { showActressNames: false });
  values = await load(fromSync);
  assert.equal(values.showActressNames, false, "同步区里的旧值先迁移，不被旧默认覆盖");
  assert.equal(values.actressLimitEnabled, true);

  for (const details of [{ reason: "install" }, { reason: "update", previousVersion: "1.2.0" }, { reason: "chrome_update" }]) {
    values = await load(await installed({}, details));
    assert.equal(values.actressLimitEnabled, false, JSON.stringify(details));
    assert.deepEqual([...values.categoryExcludeRules], [], JSON.stringify(details));
  }
});

test("升级当次迁移失败时，之后的读取补完旧默认，保存过的值不变", async () => {
  const failures = { "sync.get": true };
  const harness = createSettings({ local: {}, sync: { showActressNames: false }, failures });
  await new Promise((resolve) => harness.settings.handleInstalled({ reason: "update", previousVersion: "1.0.2" }, resolve));
  let values = await load(harness);
  assert.equal(values.actressLimitEnabled, true, "未完成时旧默认仍然生效");
  delete failures["sync.get"];
  values = await load(harness);
  assert.equal(values.showActressNames, false, "同步区里保存的值迁移过来");
  assert.equal(values.actressLimitEnabled, true);
  assert.deepEqual([...values.categoryExcludeRules], ["group:gender-diverse"]);
  assert.equal(harness.local.actressLimitEnabled, true, "旧默认已经写入");
  assert.equal(Object.hasOwn(harness.local, "earlierDefaultsPending"), false);
});
