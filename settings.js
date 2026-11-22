(() => {
  "use strict";

  // One definition of the user's preferences for the popup, pages and background.
  // Preferences live in this browser only. By default nothing needs the category
  // service: features that look videos up are turned on by the user.
  const DEFAULTS = Object.freeze({
    enabled: true,
    homepageEnabled: true,
    hideUntagged: false,
    infiniteScroll: false,
    actressLimitEnabled: false,
    maxActresses: 3,
    showActressNames: false,
    hiddenLabels: Object.freeze(["uncensored"]),
    categoryIncludeRules: Object.freeze([]),
    categoryExcludeRules: Object.freeze([])
  });
  const KEYS = Object.freeze(Object.keys(DEFAULTS));
  const VERSION_KEY = "settingsVersion";
  const VERSION = 2;

  // Earlier versions: 1.0.x kept these names in sync storage; a development
  // build kept them in local storage with the "settingsStorage" marker.
  const LEGACY_NAMES = Object.freeze({
    hiddenLabels: "blockedPresets",
    categoryIncludeRules: "genreIncludeRules",
    categoryExcludeRules: "genreExcludeRules"
  });
  const LEGACY_KEYS = Object.freeze(KEYS.map((key) => LEGACY_NAMES[key] ?? key));
  const LEGACY_LOCAL_MARKER = "settingsStorage";
  const LEGACY_DURATION_VALUES = new Set(["4小時以上", "4小时以上", "4時間以上", "4時間以上作品"]);

  const api = () => globalThis.chrome?.storage;
  const lastError = () => globalThis.chrome?.runtime?.lastError ?? null;

  function sanitize(value) {
    const sanitizeCategoryRules = (rules, fallback) => Array.isArray(rules)
      ? [...new Set(rules.map(CategoryLibrary.normalizeRule).filter(Boolean))]
      : [...fallback];

    return {
      enabled: value?.enabled !== false,
      homepageEnabled: value?.homepageEnabled !== false,
      hideUntagged: value?.hideUntagged === true,
      infiniteScroll: value?.infiniteScroll === true,
      actressLimitEnabled: value?.actressLimitEnabled === true,
      maxActresses: Number.isSafeInteger(Number(value?.maxActresses)) && Number(value.maxActresses) >= 0 &&
        value.maxActresses !== null && value.maxActresses !== ""
        ? Number(value.maxActresses) : DEFAULTS.maxActresses,
      showActressNames: value?.showActressNames === true,
      hiddenLabels: LabelLibrary.sanitizeLabelKinds(value?.hiddenLabels),
      categoryIncludeRules: sanitizeCategoryRules(value?.categoryIncludeRules, DEFAULTS.categoryIncludeRules),
      categoryExcludeRules: sanitizeCategoryRules(value?.categoryExcludeRules, DEFAULTS.categoryExcludeRules)
    };
  }

  function pickSettings(value) {
    return Object.fromEntries(KEYS
      .filter((key) => value && Object.hasOwn(value, key))
      .map((key) => [key, value[key]]));
  }

  function pickLegacy(value) {
    return Object.fromEntries(KEYS
      .filter((key) => value && Object.hasOwn(value, LEGACY_NAMES[key] ?? key))
      .map((key) => [key, value[LEGACY_NAMES[key] ?? key]]));
  }

  // Values that only earlier versions could store.
  function upgradeValues(settings) {
    const next = { ...settings };
    if (Array.isArray(next.hiddenLabels)) {
      next.hiddenLabels = next.hiddenLabels.map((kind) => kind === "english-subtitle" ? "other-subtitle" : kind);
    }
    for (const key of ["categoryIncludeRules", "categoryExcludeRules"]) {
      if (!Array.isArray(next[key])) continue;
      next[key] = next[key].map((rule) => {
        const value = CategoryLibrary.decodeValueRule(rule);
        return value !== null && LEGACY_DURATION_VALUES.has(value.normalize("NFKC").trim())
          ? CategoryLibrary.groupRule("duration-4h-plus") : rule;
      });
    }
    return next;
  }

  // Whether this context has seen the preferences under the current version,
  // and what it last loaded. Until migration succeeds, saving writes only the
  // preferences the user changed, so values not yet migrated are not replaced
  // by defaults.
  let migrated = false;
  let baseline = null;
  const changedBeforeMigration = new Set();

  // Moves earlier preferences to the current names, once. For each preference,
  // a current local value wins over an earlier local value, which wins over the
  // sync copy. The sync copy is left in place: removing it would also reset
  // other devices, so that is the user's decision. The callback receives
  // whether the preferences are now under the current version.
  function migrate(callback = () => {}) {
    const storage = api();
    if (!storage?.local) { callback(false); return; }
    storage.local.get([...new Set([...KEYS, ...LEGACY_KEYS, LEGACY_LOCAL_MARKER, VERSION_KEY])], (local) => {
      if (lastError()) { callback(false); return; }
      if (local?.[VERSION_KEY] === VERSION) { callback(true); return; }
      const finish = (synced) => {
        const merged = upgradeValues({ ...synced, ...pickLegacy(local), ...pickSettings(local) });
        const obsolete = [...Object.values(LEGACY_NAMES), LEGACY_LOCAL_MARKER]
          .filter((key) => Object.hasOwn(local ?? {}, key));
        // Another page or the background may have finished first; its result,
        // and anything saved since, must not be overwritten with this snapshot.
        storage.local.get([...KEYS, VERSION_KEY], (current) => {
          if (lastError()) { callback(false); return; }
          if (current?.[VERSION_KEY] === VERSION) { callback(true); return; }
          storage.local.set({ ...pickSettings(merged), ...pickSettings(current), [VERSION_KEY]: VERSION }, () => {
            if (lastError()) { callback(false); return; }
            if (obsolete.length === 0) { callback(true); return; }
            storage.local.remove(obsolete, () => callback(true));
          });
        });
      };
      if (!storage.sync) { finish({}); return; }
      storage.sync.get(LEGACY_KEYS, (synced) => {
        if (lastError()) {
          // A build that kept preferences locally had already copied the sync
          // area; otherwise leave it unmigrated so a later start can copy it.
          if (Object.hasOwn(local ?? {}, LEGACY_LOCAL_MARKER)) finish({});
          else callback(false);
          return;
        }
        finish(pickLegacy(synced));
      });
    });
  }

  function load(callback) {
    const local = api()?.local;
    const done = (value, isMigrated) => {
      migrated = isMigrated;
      baseline = sanitize(value);
      // The caller gets its own copy; edits to it must not move the baseline.
      // The second argument tells whether earlier preferences are fully migrated.
      callback(sanitize(value), isMigrated);
    };
    if (!local) { done({}, false); return; }
    local.get([...KEYS, VERSION_KEY], (stored) => {
      if (lastError()) { done({}, false); return; }
      if (stored?.[VERSION_KEY] === VERSION) { done(stored, true); return; }
      migrate((ok) => local.get([...KEYS, ...LEGACY_KEYS], (current) => {
        if (lastError()) { done({}, false); return; }
        // Without a completed migration, earlier local values still count.
        done(ok ? pickSettings(current) : upgradeValues({ ...pickLegacy(current), ...pickSettings(current) }), ok);
      }));
    });
  }

  function save(settings, callback = () => {}) {
    const local = api()?.local;
    if (!local) { callback(null); return; }
    // Nothing is known about the stored preferences before a load.
    if (!baseline) { callback(new Error("Settings are not loaded yet")); return; }
    const next = sanitize(settings);
    if (migrated) {
      local.set({ ...pickSettings(next), [VERSION_KEY]: VERSION }, () => callback(lastError()));
      return;
    }
    for (const key of KEYS) {
      if (JSON.stringify(next[key]) !== JSON.stringify(baseline[key])) changedBeforeMigration.add(key);
    }
    const changed = Object.fromEntries([...changedBeforeMigration].map((key) => [key, next[key]]));
    if (Object.keys(changed).length === 0) { callback(null); return; }
    local.set(changed, () => callback(lastError()));
  }

  // Offered only once the preferences are migrated; before that, the sync copy
  // may still hold the only copy of some of them.
  function hasSyncCopy(callback) {
    const sync = api()?.sync;
    if (!sync || !migrated) { callback(false); return; }
    sync.get(LEGACY_KEYS, (synced) => callback(!lastError() && Object.keys(pickLegacy(synced)).length > 0));
  }

  function removeSyncCopy(callback = () => {}) {
    const sync = api()?.sync;
    if (!sync) { callback(null); return; }
    sync.remove([...LEGACY_KEYS], () => callback(lastError()));
  }

  // Storage change events carry every key of the area; this keeps only preferences.
  function changedSettings(changes) {
    return KEYS.filter((key) => Object.hasOwn(changes ?? {}, key));
  }

  globalThis.SettingsStore = Object.freeze({
    DEFAULTS, KEYS, sanitize, load, save, migrate, hasSyncCopy, removeSyncCopy, changedSettings
  });
})();
