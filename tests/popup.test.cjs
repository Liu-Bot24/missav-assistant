const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.join(__dirname, "..");
const MODE = "missavSettingsStorageMode";
const LOCAL = "missavLocalSettings";
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class Element {
  constructor() {
    this.listeners = new Map();
    this.children = [];
    this.attributes = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    const classes = new Set();
    this.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name), toggle(name, force) {
        if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name);
      } };
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatch(type) { this.listeners.get(type)?.({ target: this, preventDefault() {} }); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  insertBefore(child, before) { child.parent = this; this.children.splice(Math.max(0, this.children.indexOf(before)), 0, child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) { return this.children.filter((child) => child.className?.includes(selector.slice(1))); }
  closest() { this.picker ??= new Element(); return this.picker; }
  blur() {}
  checkValidity() { return Number(this.value) >= 0 && Number.isInteger(Number(this.value)); }
  reportValidity() {}
}

function execute(options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const presets = ["uncensored", "chinese-subtitle", "other-subtitle"].map((value) => Object.assign(new Element(), { value }));
  const document = {
    querySelector: (selector) => element(selector.slice(1)),
    querySelectorAll: () => presets,
    createElement: () => new Element(),
    createTextNode: (text) => Object.assign(new Element(), { textContent: text }),
    addEventListener() {}
  };
  const data = {
    local: clone(options.local ?? { [MODE]: "local", [LOCAL]: { enabled: true } }),
    sync: clone(options.sync ?? {})
  };
  const timers = new Map();
  const writes = [];
  const pendingWrites = [];
  const pendingReads = [];
  const cacheMessages = [];
  const listeners = [];
  const confirmations = [];
  let nextTimer = 0;
  let readError = options.readError;
  let deferReads = options.deferReads;
  const chrome = { runtime: { lastError: null, sendMessage(message, callback) { cacheMessages.push({ message, callback }); } }, storage: {
    onChanged: { addListener(callback) { listeners.push(callback); } }
  } };
  function withError(message, callback) {
    chrome.runtime.lastError = message ? { message } : null;
    callback();
    chrome.runtime.lastError = null;
  }
  for (const area of ["local", "sync"]) chrome.storage[area] = {
    get(keys, callback) {
      const values = Array.isArray(keys) ? {} : { ...keys };
      for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
        if (Object.hasOwn(data[area], key)) values[key] = clone(data[area][key]);
      }
      const metadataRead = !Array.isArray(keys);
      if (deferReads && !metadataRead) { pendingReads.push({ callback, values }); return; }
      const error = metadataRead ? null : readError;
      if (!metadataRead) readError = null;
      withError(error, () => callback(values));
    },
    set(values, callback) {
      const operation = { area, values: clone(values), callback };
      writes.push(operation);
      if (options.deferWrites) pendingWrites.push(operation);
      else completeWrite(operation);
    }
  };
  function completeWrite(operation, error) {
    if (!error) Object.assign(data[operation.area], operation.values);
    withError(error, () => operation.callback());
  }
  if (options.noStorage) delete chrome.storage;
  const context = {
    chrome, document, TextEncoder,
    confirm(message) { confirmations.push(message); return options.confirm !== false; },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    MissavLabelLibrary: { sanitizePresets: (value) => Array.isArray(value) ? value : ["uncensored"] },
    MissavGenreLibrary: { normalizeRule: (value) => value, decodeValueRule: (value) => value, options: () => [] }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "settings-storage.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, "popup.js"), "utf8"), context);
  return { data, element, writes, pendingWrites, pendingReads, cacheMessages, confirmations, chrome,
    set deferReads(value) { deferReads = value; },
    change(id, value) { element(id).checked = value; element(id).dispatch("change"); },
    click(id) { element(id).dispatch("click"); },
    timers() { const tasks = [...timers.values()]; timers.clear(); for (const task of tasks) task(); },
    completeWrite, withError,
    emit(changes, area) { for (const listener of listeners) listener(changes, area); }
  };
}

test("popup shows saved only after successful storage acknowledgement", () => {
  const h = execute({ deferWrites: true });
  h.change("enabled", false);
  assert.match(h.element("saveState").textContent, /正在保存/);
  h.timers();
  assert.equal(h.data.local[LOCAL].enabled, true);
  assert.doesNotMatch(h.element("saveState").textContent, /已保存，页面/);
  h.completeWrite(h.pendingWrites.shift());
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.match(h.element("saveState").textContent, /^已保存，页面/);
  assert.equal(h.element("statusBadge").textContent, "已暂停");
});

test("quota failure stays visibly unsaved and retry writes the latest desired state", () => {
  const h = execute({ deferWrites: true, local: { [MODE]: "sync" }, sync: { enabled: true } });
  h.change("enabled", false);
  h.timers();
  h.completeWrite(h.pendingWrites.shift(), "MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded");
  assert.equal(h.data.sync.enabled, true);
  assert.equal(h.element("enabled").checked, false);
  assert.equal(h.element("statusBadge").textContent, "未保存");
  assert.match(h.element("saveState").textContent, /未保存.*quota/);
  assert.equal(h.element("retrySaveButton").hidden, false);
  h.click("retrySaveButton");
  h.completeWrite(h.pendingWrites.shift());
  assert.equal(h.data.sync.enabled, false);
  assert.match(h.element("saveState").textContent, /^已保存，页面/);
  assert.equal(h.element("retrySaveButton").hidden, true);
});

test("rapid edits are coalesced and writes are serialized; an old callback cannot report newer edits saved", () => {
  const h = execute({ deferWrites: true });
  h.change("enabled", false);
  h.change("homepageEnabled", false);
  h.timers();
  assert.equal(h.writes.length, 1);
  const first = h.pendingWrites.shift();
  assert.equal(first.values[LOCAL].enabled, false);
  assert.equal(first.values[LOCAL].homepageEnabled, false);
  h.change("enabled", true);
  h.timers();
  assert.equal(h.writes.length, 1);
  h.completeWrite(first);
  assert.equal(h.pendingWrites.length, 1);
  assert.equal(h.writes.length, 2);
  assert.doesNotMatch(h.element("saveState").textContent, /已保存，页面/);
  h.completeWrite(h.pendingWrites.shift());
  assert.equal(h.data.local[LOCAL].enabled, true);
  assert.equal(h.data.local[LOCAL].homepageEnabled, false);
  first.callback();
  assert.equal(h.writes.length, 2);
  assert.equal(h.element("enabled").checked, true);
  assert.match(h.element("saveState").textContent, /^已保存，页面/);
});

test("failure during a burst does not automatically retry quota failures or lose queued edits", () => {
  const h = execute({ deferWrites: true });
  h.change("enabled", false);
  h.timers();
  h.change("homepageEnabled", false);
  h.completeWrite(h.pendingWrites.shift(), "quota exceeded");
  h.timers();
  assert.equal(h.writes.length, 1);
  h.click("retrySaveButton");
  assert.equal(h.writes.length, 2);
  h.completeWrite(h.pendingWrites.shift());
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.equal(h.data.local[LOCAL].homepageEnabled, false);
});

test("initial read failure blocks editing and supports explicit reload", () => {
  const h = execute({ readError: "cannot read settings" });
  assert.equal(h.element("settingsFields").disabled, true);
  assert.match(h.element("saveState").textContent, /读取失败/);
  h.change("enabled", false);
  h.timers();
  assert.equal(h.writes.length, 0);
  h.click("reloadSettingsButton");
  assert.equal(h.element("settingsFields").disabled, false);
  assert.equal(h.element("enabled").checked, true);
});

test("unavailable storage API never displays save success", () => {
  const h = execute({ noStorage: true });
  h.change("enabled", false);
  h.timers();
  assert.equal(h.writes.length, 0);
  assert.equal(h.element("settingsFields").disabled, true);
  assert.match(h.element("saveState").textContent, /读取失败.*存储不可用/);
  assert.doesNotMatch(h.element("saveState").textContent, /已保存，页面/);
});

test("late initial read cannot replace a newer reload snapshot", () => {
  const h = execute({ deferReads: true });
  const old = h.pendingReads.shift();
  assert.equal(h.element("settingsFields").disabled, true);
  h.data.local[LOCAL] = { enabled: false };
  h.click("reloadSettingsButton");
  h.pendingReads.shift().callback({ [MODE]: "local", [LOCAL]: { enabled: false } });
  old.callback(old.values);
  assert.equal(h.element("enabled").checked, false);
  assert.equal(h.element("statusBadge").textContent, "已暂停");
});

test("legacy migration waits for an informed choice and copying local never writes sync", () => {
  const h = execute({ local: {}, sync: { enabled: false } });
  assert.equal(h.element("settingsFields").disabled, true);
  assert.equal(h.element("enabled").checked, false);
  assert.equal(h.element("storageOptions").hidden, false);
  assert.equal(h.writes.length, 0);
  h.click("copyToLocalButton");
  assert.match(h.confirmations[0], /替换.*已有.*副本/);
  assert.match(h.confirmations[0], /旧同步副本不会删除/);
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.deepEqual(h.data.sync, { enabled: false });
  assert.equal(h.writes.some((item) => item.area === "sync"), false);
  assert.equal(h.element("settingsFields").disabled, false);
});

test("declining a storage choice makes no writes", () => {
  const h = execute({ local: {}, sync: { enabled: false }, confirm: false });
  h.click("copyToSyncButton");
  assert.equal(h.writes.length, 0);
  assert.equal(h.element("settingsFields").disabled, true);
});

test("existing sync choice is explicit and does not upload local preferences", () => {
  const h = execute({ sync: { enabled: false } });
  h.click("storageOptionsButton");
  h.click("useSyncCopyButton");
  assert.match(h.confirmations[0], /同账号设备/);
  assert.equal(h.data.local[MODE], "sync");
  assert.equal(h.data.sync.enabled, false);
  assert.equal(h.element("enabled").checked, false);
  assert.equal(h.writes.some((item) => item.area === "sync"), false);
});

test("partial sync upload failure is visible and cannot silently retry or enable editing", () => {
  const h = execute({ deferWrites: true });
  h.click("storageOptionsButton");
  h.click("copyToSyncButton");
  h.completeWrite(h.pendingWrites.shift());
  h.completeWrite(h.pendingWrites.shift(), "local storage failed");
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.data.sync.enabled, true);
  assert.match(h.element("saveState").textContent, /同步副本已上传.*切换失败/);
  assert.equal(h.element("settingsFields").disabled, true);
  assert.equal(h.element("reloadSettingsButton").hidden, false);
  h.timers();
  assert.equal(h.writes.length, 2);
});

test("cache clear reports response errors and accepts only explicit success", () => {
  const h = execute({ local: { [MODE]: "local", metadataCacheCount: 8 } });
  h.click("clearCacheButton");
  h.click("clearCacheButton");
  assert.equal(h.cacheMessages.length, 1);
  assert.equal(h.cacheMessages[0].message.type, "missav-clear-metadata-cache");
  h.cacheMessages.shift().callback({ ok: false, error: "clear rejected" });
  assert.match(h.element("cacheState").textContent, /清除失败.*clear rejected/);
  assert.match(h.element("genreCount").textContent, /已缓存 8/);
  h.click("clearCacheButton");
  h.cacheMessages.shift().callback({ ok: true });
  assert.match(h.element("cacheState").textContent, /已清除/);
  assert.match(h.element("genreCount").textContent, /已缓存 0/);
  assert.equal(h.writes.length, 0);
});

test("cache clear handles an unavailable background without claiming success", () => {
  const h = execute();
  delete h.chrome.runtime.sendMessage;
  h.click("clearCacheButton");
  assert.match(h.element("cacheState").textContent, /清除失败.*后台通信不可用/);
  assert.equal(h.element("clearCacheButton").disabled, false);
});

test("storage disappearing or throwing during a save leaves the edit unsaved", () => {
  for (const failure of ["missing", "throwing"]) {
    const h = execute();
    if (failure === "missing") delete h.chrome.storage.local.set;
    else h.chrome.storage.local.set = () => { throw new Error("storage context invalidated"); };
    h.change("enabled", false);
    h.timers();
    assert.equal(h.data.local[LOCAL].enabled, true);
    assert.match(h.element("saveState").textContent, /^未保存/);
    assert.equal(h.element("retrySaveButton").hidden, false);
  }
});

test("oversized unsaved sync edits can be explicitly preserved in local storage", () => {
  const h = execute({ local: { [MODE]: "sync" }, sync: { enabled: true, genreIncludeRules: ["x".repeat(9000)] } });
  h.change("enabled", false);
  h.timers();
  assert.match(h.element("saveState").textContent, /未保存.*单项上限/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.element("storageOptionsButton").disabled, false);
  h.click("storageOptionsButton");
  h.click("copyToLocalButton");
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.equal(h.data.local[LOCAL].genreIncludeRules[0].length, 9000);
  assert.equal(h.data.sync.enabled, true);
  assert.equal(h.element("retrySaveButton").hidden, true);
  assert.equal(h.element("statusBadge").textContent, "已暂停");
});

test("reset stays in the selected area and requires acknowledged persistence", () => {
  const h = execute({ deferWrites: true, local: { [MODE]: "local", [LOCAL]: { enabled: false, maxActresses: 8 } },
    sync: { enabled: false, maxActresses: 20 } });
  h.click("resetButton");
  h.timers();
  assert.equal(h.data.local[LOCAL].maxActresses, 8);
  assert.doesNotMatch(h.element("saveState").textContent, /^已保存/);
  h.completeWrite(h.pendingWrites.shift());
  assert.equal(h.data.local[LOCAL].maxActresses, 3);
  assert.deepEqual(h.data.sync, { enabled: false, maxActresses: 20 });
});

test("mode changed elsewhere stops writes and asks for a fresh read", () => {
  const h = execute({ sync: { enabled: false } });
  h.change("enabled", false);
  h.data.local[MODE] = "sync";
  h.timers();
  assert.equal(h.writes.length, 0);
  assert.equal(h.element("settingsFields").disabled, true);
  assert.equal(h.element("retrySaveButton").hidden, true);
  assert.equal(h.element("reloadSettingsButton").hidden, false);
  assert.match(h.element("saveState").textContent, /存储位置已变化/);
});
