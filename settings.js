(() => {
  "use strict";

  // One definition of the user's preferences for the popup, pages and background.
  // Preferences live in this browser only; older versions kept them in sync storage.
  const DEFAULTS = Object.freeze({
    enabled: true,
    homepageEnabled: true,
    hideUntagged: false,
    infiniteScroll: false,
    actressLimitEnabled: true,
    maxActresses: 3,
    showActressNames: true,
    blockedPresets: Object.freeze(["uncensored"]),
    genreIncludeRules: Object.freeze([]),
    genreExcludeRules: Object.freeze(["group:gender-diverse"])
  });
  const KEYS = Object.freeze(Object.keys(DEFAULTS));
  const STORAGE_MARKER = "settingsStorage";

  const api = () => globalThis.chrome?.storage;
  const lastError = () => globalThis.chrome?.runtime?.lastError ?? null;

  function sanitize(value) {
    const sanitizeGenreRules = (rules, fallback) => Array.isArray(rules)
      ? [...new Set(rules.map(MissavGenreLibrary.normalizeRule).filter(Boolean))]
      : [...fallback];

    return {
      enabled: value?.enabled !== false,
      homepageEnabled: value?.homepageEnabled !== false,
      hideUntagged: value?.hideUntagged === true,
      infiniteScroll: value?.infiniteScroll === true,
      actressLimitEnabled: value?.actressLimitEnabled !== false,
      maxActresses: Number.isSafeInteger(Number(value?.maxActresses)) && Number(value.maxActresses) >= 0 &&
        value.maxActresses !== null && value.maxActresses !== ""
        ? Number(value.maxActresses) : DEFAULTS.maxActresses,
      showActressNames: value?.showActressNames !== false,
      blockedPresets: MissavLabelLibrary.sanitizePresets(value?.blockedPresets),
      genreIncludeRules: sanitizeGenreRules(value?.genreIncludeRules, DEFAULTS.genreIncludeRules),
      genreExcludeRules: sanitizeGenreRules(value?.genreExcludeRules, DEFAULTS.genreExcludeRules)
    };
  }

  function pickSettings(value) {
    return Object.fromEntries(KEYS
      .filter((key) => value && Object.hasOwn(value, key))
      .map((key) => [key, value[key]]));
  }

  // Copies preferences from sync storage once. The sync copy is left in place:
  // removing it would also reset other devices, so that is the user's decision.
  function migrate(callback = () => {}) {
    const storage = api();
    if (!storage?.local) { callback(); return; }
    const finish = (copy) => storage.local.get(KEYS, (local) => {
      if (lastError()) { callback(); return; }
      // Never replace a preference this browser has already saved locally.
      const missing = Object.fromEntries(Object.entries(copy)
        .filter(([key]) => !Object.hasOwn(local ?? {}, key)));
      storage.local.set({ ...missing, [STORAGE_MARKER]: "local" }, () => callback());
    });
    if (!storage.sync) { finish({}); return; }
    storage.sync.get(KEYS, (synced) => {
      // An unreadable sync area stays unmigrated, so a later start can copy it.
      if (lastError()) { callback(); return; }
      finish(pickSettings(synced));
    });
  }

  function load(callback) {
    const local = api()?.local;
    if (!local) { callback(sanitize({})); return; }
    local.get([...KEYS, STORAGE_MARKER], (stored) => {
      if (lastError()) { callback(sanitize({})); return; }
      if (stored?.[STORAGE_MARKER] === "local") { callback(sanitize(stored)); return; }
      migrate(() => local.get(KEYS, (migrated) => callback(sanitize(lastError() ? {} : migrated))));
    });
  }

  function save(settings, callback = () => {}) {
    const local = api()?.local;
    if (!local) { callback(null); return; }
    local.set({ ...pickSettings(sanitize(settings)), [STORAGE_MARKER]: "local" }, () => callback(lastError()));
  }

  function hasSyncCopy(callback) {
    const sync = api()?.sync;
    if (!sync) { callback(false); return; }
    sync.get(KEYS, (synced) => callback(!lastError() && Object.keys(pickSettings(synced)).length > 0));
  }

  function removeSyncCopy(callback = () => {}) {
    const sync = api()?.sync;
    if (!sync) { callback(null); return; }
    sync.remove([...KEYS], () => callback(lastError()));
  }

  // Storage change events carry every key of the area; this keeps only preferences.
  function changedSettings(changes) {
    return KEYS.filter((key) => Object.hasOwn(changes ?? {}, key));
  }

  globalThis.MissavSettings = Object.freeze({
    DEFAULTS, KEYS, sanitize, load, save, migrate, hasSyncCopy, removeSyncCopy, changedSettings
  });
})();
