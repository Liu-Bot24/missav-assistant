const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "settings-storage.js"), "utf8");
const defaults = { enabled: true, genreIncludeRules: [], maxActresses: 3 };
const MODE = "missavSettingsStorageMode";
const LOCAL = "missavLocalSettings";
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const data = { local: clone(options.local ?? {}), sync: clone(options.sync ?? {}) };
  const calls = [];
  const listeners = new Set();
  const pending = [];
  const failures = [];
  const chrome = { runtime: { lastError: null }, storage: {
    onChanged: { addListener: (callback) => listeners.add(callback), removeListener: (callback) => listeners.delete(callback) }
  } };
  let deferGets = false;
  for (const name of ["local", "sync"]) {
    chrome.storage[name] = {
      get(keys, callback) {
        calls.push({ name, method: "get", value: clone(keys) });
        const result = {};
        for (const key of keys) if (Object.hasOwn(data[name], key)) result[key] = clone(data[name][key]);
        const operation = { name, callback, result };
        if (deferGets) pending.push(operation);
        else complete(operation);
      },
      set(value, callback) {
        calls.push({ name, method: "set", value: clone(value) });
        complete({ name, callback, write: clone(value) });
      }
    };
  }
  function complete(operation) {
    const failureIndex = failures.findIndex((item) => item.name === operation.name &&
      item.method === (operation.write ? "set" : "get"));
    const failure = failureIndex < 0 ? null : failures.splice(failureIndex, 1)[0];
    chrome.runtime.lastError = failure ? { message: failure.message } : null;
    if (!failure && operation.write) Object.assign(data[operation.name], operation.write);
    operation.callback(clone(operation.result));
    chrome.runtime.lastError = null;
  }
  const context = { chrome, TextEncoder, navigator: { locks: options.locks ?? { request(_name, callback) { return callback(); } } } };
  if (options.noLocks) delete context.navigator;
  vm.runInNewContext(source, context);
  const store = context.MissavSettingsStorage.create({ defaults });
  const result = (method, ...args) => {
    let outcome;
    store[method](...args, (error, value) => { outcome = { error, value: clone(value) }; });
    return outcome;
  };
  return { data, calls, chrome, store, result, pending, complete,
    createStore: () => context.MissavSettingsStorage.create({ defaults }),
    fail(name, method, message = "storage unavailable") { failures.push({ name, method, message }); },
    set deferGets(value) { deferGets = value; },
    emit(changes, area) { for (const listener of listeners) listener(changes, area); },
    get listenerCount() { return listeners.size; }
  };
}

test("fresh settings default to local without writing during read", () => {
  const h = harness();
  assert.deepEqual(h.result("read"), { error: null, value: { mode: "local", settings: defaults } });
  assert.equal(h.calls.some((call) => call.method === "set"), false);
  assert.equal(h.result("save", { ...defaults, enabled: false }, "local").error, null);
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.equal(h.calls.some((call) => call.name === "sync" && call.method === "set"), false);
});

test("explicit local mode ignores sync values and does not require sync API", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: { enabled: false } }, sync: { enabled: true } });
  delete h.chrome.storage.sync;
  assert.equal(h.result("read").value.settings.enabled, false);
  assert.equal(h.result("save", defaults, "local").error, null);
  assert.equal(h.calls.some((call) => call.name === "sync"), false);
});

test("legacy settings remain active and cannot be silently edited before choosing a mode", () => {
  const h = harness({ local: { [LOCAL]: { enabled: true } }, sync: { enabled: false } });
  assert.equal(h.result("read").value.mode, "legacy");
  assert.equal(h.result("read").value.settings.enabled, false);
  const outcome = h.result("save", defaults, "local");
  assert.equal(outcome.error.modeChanged, true);
  assert.deepEqual(h.data, { local: { [LOCAL]: { enabled: true } }, sync: { enabled: false } });
  assert.equal(h.calls.some((call) => call.method === "set"), false);
});

test("explicit legacy copy to local preserves the old sync copy", () => {
  const h = harness({ sync: { enabled: false, genreIncludeRules: ["synthetic"] } });
  const legacy = h.result("read").value;
  assert.equal(h.result("select", "local", "current", legacy.settings).error, null);
  assert.equal(h.data.local[LOCAL].enabled, false);
  assert.deepEqual(h.data.sync, { enabled: false, genreIncludeRules: ["synthetic"] });
  assert.equal(h.result("read").value.mode, "local");
});

test("selecting an existing sync copy never uploads or overwrites either copy", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: { enabled: true } }, sync: { enabled: false } });
  assert.equal(h.result("select", "sync", "existing", defaults).value.settings.enabled, false);
  assert.deepEqual(h.data.sync, { enabled: false });
  assert.deepEqual(h.data.local[LOCAL], { enabled: true });
  assert.equal(h.data.local[MODE], "sync");
  assert.equal(h.calls.some((call) => call.name === "sync" && call.method === "set"), false);
});

test("selecting an existing local copy leaves the sync copy intact", () => {
  const h = harness({ local: { [MODE]: "sync", [LOCAL]: { enabled: false } }, sync: { enabled: true } });
  assert.equal(h.result("select", "local", "existing", defaults).value.settings.enabled, false);
  assert.deepEqual(h.data.sync, { enabled: true });
  assert.deepEqual(h.data.local[LOCAL], { enabled: false });
});

test("explicit upload replaces sync settings only after selecting current as source", () => {
  const h = harness({ local: { [MODE]: "local" }, sync: { enabled: false } });
  const outcome = h.result("select", "sync", "current", defaults);
  assert.equal(outcome.error, null);
  assert.deepEqual(h.data.sync, defaults);
  assert.equal(h.data.local[MODE], "sync");
});

test("missing existing copy does not activate or write defaults", () => {
  const h = harness({ local: { [MODE]: "local" } });
  assert.match(h.result("select", "sync", "existing", defaults).error.message, /不存在/);
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.calls.some((call) => call.method === "set"), false);
});

test("initial read failures and unavailable APIs are errors, never default success", () => {
  const h = harness();
  h.fail("local", "get", "read unavailable");
  assert.match(h.result("read").error.message, /read unavailable/);
  delete h.chrome.storage.local;
  assert.match(h.result("read").error.message, /存储不可用/);
  assert.equal(h.calls.some((call) => call.method === "set"), false);
});

test("unknown legacy state on sync read failure is not treated as a fresh install", () => {
  const h = harness({ sync: { enabled: false } });
  h.fail("sync", "get");
  assert.ok(h.result("read").error);
  assert.deepEqual(h.data.local, {});
});

test("quota rejection preserves stored snapshot and does not activate sync", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: defaults }, sync: { enabled: false } });
  h.fail("sync", "set", "MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded");
  assert.match(h.result("select", "sync", "current", defaults).error.message, /quota/);
  assert.equal(h.data.local[MODE], "local");
  assert.equal(h.data.sync.enabled, false);
});

test("oversized sync item is rejected before upload and local mode still accepts it", () => {
  const settings = { ...defaults, genreIncludeRules: ["汉".repeat(4000)] };
  const h = harness({ local: { [MODE]: "local" } });
  assert.match(h.result("select", "sync", "current", settings).error.message, /单项上限/);
  assert.equal(h.calls.some((call) => call.method === "set"), false);
  assert.equal(h.result("save", settings, "local").error, null);
  assert.equal(h.data.local[LOCAL].genreIncludeRules[0], settings.genreIncludeRules[0]);
});

test("partial upload followed by mode-marker failure is explicitly reported", () => {
  const h = harness({ local: { [MODE]: "local" } });
  h.fail("local", "set", "marker write failed");
  const outcome = h.result("select", "sync", "current", defaults);
  assert.equal(outcome.error.syncWritten, true);
  assert.match(outcome.error.message, /同步副本已上传/);
  assert.equal(h.data.local[MODE], "local");
  assert.deepEqual(h.data.sync, defaults);
});

test("save rechecks mode instead of overwriting a deselected area", () => {
  const h = harness({ local: { [MODE]: "sync" }, sync: { enabled: false } });
  assert.equal(h.result("save", defaults, "local").error.modeChanged, true);
  assert.equal(h.calls.some((call) => call.method === "set"), false);
});

test("subscribe follows the chosen area, ignores cache events, and stops after unsubscribe", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: { enabled: false } }, sync: { enabled: true } });
  const snapshots = [];
  const off = h.store.subscribe((error, value) => snapshots.push({ error, value: clone(value) }));
  const readCount = h.calls.length;
  h.emit({ metadataCacheCount: { newValue: 1 } }, "local");
  assert.equal(h.calls.length, readCount);
  h.emit({ enabled: { newValue: true } }, "sync");
  assert.equal(snapshots.length, 1);
  h.data.local[MODE] = "sync";
  h.emit({ [MODE]: { newValue: "sync" } }, "local");
  assert.equal(snapshots.at(-1).value.mode, "sync");
  assert.equal(snapshots.at(-1).value.settings.enabled, true);
  off();
  assert.equal(h.listenerCount, 0);
});

test("late old reads cannot overwrite a newer mode or preference snapshot", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: { enabled: false } } });
  h.deferGets = true;
  const snapshots = [];
  const off = h.store.subscribe((error, value) => snapshots.push({ error, value: clone(value) }));
  const old = h.pending.shift();
  h.data.local[LOCAL] = { enabled: true };
  h.emit({ [LOCAL]: { newValue: { enabled: true } } }, "local");
  h.complete(h.pending.shift());
  h.complete(old);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].value.settings.enabled, true);
  off();
});

test("read error recovery emits confirmed state even when values have not changed", () => {
  const h = harness({ local: { [MODE]: "local", [LOCAL]: defaults } });
  const outcomes = [];
  h.store.subscribe((error, snapshot) => outcomes.push(error || snapshot));
  h.fail("local", "get");
  h.emit({ [LOCAL]: { newValue: defaults } }, "local");
  h.emit({ [LOCAL]: { newValue: defaults } }, "local");
  assert.equal(outcomes.length, 3);
  assert.equal(outcomes[2].mode, "local");
});

test("promise rejection and duplicate callbacks settle once", async () => {
  const h = harness({ local: { [MODE]: "local" } });
  h.chrome.storage.local.get = () => Promise.reject(new Error("read rejected"));
  const error = await new Promise((resolve) => h.store.read((failure) => resolve(failure)));
  assert.match(error.message, /read rejected/);
  h.chrome.storage.local.get = (_keys, callback) => { callback({ [MODE]: "local" }); callback({ [MODE]: "sync" }); };
  let calls = 0;
  h.store.read(() => calls++);
  assert.equal(calls, 1);
});


function sharedLocks() {
  let tail = Promise.resolve();
  return { request(_name, callback) {
    const next = tail.then(callback);
    tail = next.catch(() => {});
    return next;
  } };
}

test("cross-popup save and mode selection share a lock until storage acknowledgement", async () => {
  for (const [initialMode, nextMode] of [["sync", "local"], ["local", "sync"]]) {
    const h = harness({ locks: sharedLocks(), local: { [MODE]: initialMode, [LOCAL]: { enabled: false } }, sync: { enabled: true } });
    const second = h.createStore();
    h.deferGets = true;
    const first = new Promise(resolve => h.store.save({ ...defaults, enabled: false }, initialMode, (error) => resolve(error)));
    await new Promise(setImmediate);
    if (initialMode === "sync") { h.complete(h.pending.shift()); }
    let selected = false;
    h.deferGets = false;
    const selection = new Promise(resolve => second.select(nextMode, "existing", defaults, (error) => { selected = true; resolve(error); }));
    await new Promise(setImmediate);
    assert.equal(selected, false, "mode selection must wait for the earlier pending save");
    h.complete(h.pending.shift());
    assert.equal(await first, null);
    assert.equal(await selection, null);
    assert.equal(h.data.local[MODE], nextMode);
    const before = h.calls.filter(call => call.method === "set").length;
    const staleError = await new Promise(resolve => h.store.save(defaults, initialMode, error => resolve(error)));
    assert.equal(staleError.modeChanged, true);
    assert.equal(h.calls.filter(call => call.method === "set").length, before, "stale popup cannot write or reverse the selected mode");
  }
});

test("missing shared-lock support rejects writes without changing either storage area", () => {
  const h = harness({ noLocks: true });
  assert.match(h.result("save", defaults, "local").error.message, /安全.*保存/);
  assert.match(h.result("select", "local", "current", defaults).error.message, /安全.*保存/);
  assert.equal(h.calls.some(call => call.method === "set"), false);
});
