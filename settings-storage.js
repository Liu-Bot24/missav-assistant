(() => {
  "use strict";

  const MODE_KEY = "missavSettingsStorageMode";
  const LOCAL_KEY = "missavLocalSettings";

  // Reads never migrate or delete data. Only an explicit popup choice changes an
  // existing installation's storage mode; legacy sync preferences remain active.
  function create({ defaults, sanitize = (value) => value, chromeApi = globalThis.chrome }) {
    const keys = Object.keys(defaults);
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const normalize = (value) => sanitize({ ...copy(defaults), ...value });
    const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const hasSyncSettings = (value) => keys.some((key) => Object.hasOwn(value, key));

    function invoke(areaName, method, value, callback) {
      const area = chromeApi?.storage?.[areaName];
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        callback(error, result);
      };
      if (typeof area?.[method] !== "function") {
        finish(new Error(`${areaName === "local" ? "本机" : "同步"}存储不可用，请重新打开扩展后重试`));
        return;
      }
      try {
        const promise = area[method](value, (result) => {
          const lastError = chromeApi?.runtime?.lastError;
          finish(lastError ? new Error(lastError.message || "浏览器存储操作失败") : null, result);
        });
        // Some test/host environments expose promise-based APIs. Once-only
        // settlement also protects against an erroneously repeated callback.
        if (promise?.then) promise.then((result) => finish(null, result), (error) => finish(error));
      } catch (error) {
        if (finished) throw error;
        finish(error);
      }
    }

    function read(callback) {
      invoke("local", "get", [MODE_KEY, LOCAL_KEY], (error, local) => {
        if (error) return callback(error);
        const localValues = isRecord(local) ? local : {};
        const mode = localValues[MODE_KEY];
        if (mode === "local") {
          callback(null, { mode, settings: normalize(localValues[LOCAL_KEY]) });
          return;
        }
        invoke("sync", "get", keys, (syncError, stored) => {
          if (syncError) return callback(syncError);
          const syncValues = isRecord(stored) ? stored : {};
          const legacy = mode !== "sync" && hasSyncSettings(syncValues);
          callback(null, {
            mode: mode === "sync" ? "sync" : legacy ? "legacy" : "local",
            settings: normalize(mode === "sync" || legacy ? syncValues : localValues[LOCAL_KEY])
          });
        });
      });
    }

    function inspect(callback) {
      invoke("local", "get", [MODE_KEY, LOCAL_KEY], (error, local) => {
        if (error) return callback(error);
        invoke("sync", "get", keys, (syncError, sync) => {
          if (syncError) return callback(syncError);
          callback(null, {
            local: isRecord(local?.[LOCAL_KEY]) ? normalize(local[LOCAL_KEY]) : null,
            sync: isRecord(sync) && hasSyncSettings(sync) ? normalize(sync) : null
          });
        });
      });
    }

    function checkSyncSize(value) {
      const perItemLimit = chromeApi?.storage?.sync?.QUOTA_BYTES_PER_ITEM || 8192;
      const bytes = (text) => new TextEncoder().encode(text).length;
      const sizes = keys.map((key) => bytes(key) + bytes(JSON.stringify(value[key])));
      if (sizes.some((size) => size > perItemLimit)) {
        return new Error("某项筛选设置超过同步存储单项上限；请减少分类，或改用仅本机保存");
      }
      if (sizes.reduce((sum, size) => sum + size, 0) > (chromeApi?.storage?.sync?.QUOTA_BYTES || 102400)) {
        return new Error("筛选设置超过同步存储总容量；请减少分类，或改用仅本机保存");
      }
      return null;
    }

    function writeArea(mode, value, callback) {
      const settings = normalize(value);
      if (mode === "sync") {
        const error = checkSyncSize(settings);
        if (error) return callback(error);
        invoke("sync", "set", copy(settings), (writeError) => callback(writeError, { mode, settings }));
      } else {
        invoke("local", "set", { [MODE_KEY]: "local", [LOCAL_KEY]: copy(settings) },
          (error) => callback(error, { mode: "local", settings }));
      }
    }

    // The popup serializes saves. Verify the mode again so an already-open popup
    // cannot silently write to an area that another extension page deselected.
    function save(value, expectedMode, callback) {
      read((error, snapshot) => {
        if (error) return callback(error);
        if (!["local", "sync"].includes(expectedMode) || snapshot.mode !== expectedMode) {
          const modeError = new Error("存储位置已变化或尚未选择，请重新读取设置后再保存");
          modeError.modeChanged = true;
          callback(modeError);
          return;
        }
        writeArea(expectedMode, value, callback);
      });
    }

    // source=current replaces that destination only after the popup's explicit
    // informed choice. source=existing preserves both stored copies unchanged.
    function select(mode, source, current, callback) {
      if (!["local", "sync"].includes(mode) || !["current", "existing"].includes(source)) {
        callback(new Error("请选择有效的存储位置与设置副本"));
        return;
      }
      const activate = (settings, uploaded = false) => {
        invoke("local", "set", { [MODE_KEY]: mode }, (error) => {
          if (error && uploaded) {
            const partial = new Error(`同步副本已上传，但存储位置切换失败：${error.message}。请重新读取后确认`);
            partial.syncWritten = true;
            callback(partial);
            return;
          }
          callback(error, { mode, settings });
        });
      };
      if (source === "existing") {
        invoke(mode, "get", mode === "local" ? [LOCAL_KEY] : keys, (error, stored) => {
          if (error) return callback(error);
          const existing = mode === "local" ? stored?.[LOCAL_KEY] : stored;
          if (!isRecord(existing) || (mode === "sync" && !hasSyncSettings(existing))) {
            callback(new Error("所选设置副本已不存在，请重新读取后选择"));
            return;
          }
          activate(normalize(existing));
        });
        return;
      }
      writeArea(mode, current, (error, snapshot) => {
        if (error) return callback(error);
        if (mode === "local") callback(null, snapshot);
        else activate(snapshot.settings, true);
      });
    }

    function subscribe(callback) {
      let generation = 0;
      let lastSnapshot;
      let closed = false;
      const refresh = () => {
        const request = ++generation;
        read((error, snapshot) => {
          if (closed || request !== generation) return;
          if (error) { lastSnapshot = undefined; callback(error); return; }
          const signature = JSON.stringify(snapshot);
          if (signature === lastSnapshot) return;
          lastSnapshot = signature;
          callback(null, snapshot);
        });
      };
      const listener = (changes, areaName) => {
        if ((areaName === "local" && (changes[MODE_KEY] || changes[LOCAL_KEY])) ||
            (areaName === "sync" && keys.some((key) => changes[key]))) refresh();
      };
      chromeApi?.storage?.onChanged?.addListener(listener);
      refresh();
      return () => {
        closed = true;
        generation += 1;
        chromeApi?.storage?.onChanged?.removeListener?.(listener);
      };
    }

    return Object.freeze({ read, inspect, save, select, subscribe });
  }

  globalThis.MissavSettingsStorage = Object.freeze({ create, MODE_KEY, LOCAL_KEY });
})();
