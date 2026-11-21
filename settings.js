(() => {
  "use strict";

  // One definition of the user's preferences for the popup, pages and background.
  // Preferences live in this browser only.
  const DEFAULTS = Object.freeze({
    enabled: true,
    homepageEnabled: true,
    hideUntagged: false,
    infiniteScroll: false,
    actressLimitEnabled: true,
    maxActresses: 3,
    showActressNames: true,
    hiddenLabels: Object.freeze(["uncensored"]),
    categoryIncludeRules: Object.freeze([]),
    categoryExcludeRules: Object.freeze(["group:gender-diverse"])
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
      actressLimitEnabled: value?.actressLimitEnabled !== false,
      maxActresses: Number.isSafeInteger(Number(value?.maxActresses)) && Number(value.maxActresses) >= 0 &&
        value.maxActresses !== null && value.maxActresses !== ""
        ? Number(value.maxActresses) : DEFAULTS.maxActresses,
      showActressNames: value?.showActressNames !== false,
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

  // Moves earlier preferences to the current names, once. Settings already in
  // local storage win over the sync copy. The sync copy is left in place:
  // removing it would also reset other devices, so that is the user's decision.
  function migrate(callback = () => {}) {
    const storage = api();
    if (!storage?.local) { callback(); return; }
    storage.local.get([...new Set([...KEYS, ...LEGACY_KEYS, LEGACY_LOCAL_MARKER])], (local) => {
      if (lastError()) { callback(); return; }
      const finish = (synced) => {
        const merged = upgradeValues({ ...synced, ...pickLegacy(local), ...pickSettings(local) });
        const obsolete = [...Object.values(LEGACY_NAMES), LEGACY_LOCAL_MARKER]
          .filter((key) => Object.hasOwn(local ?? {}, key));
        storage.local.set({ ...pickSettings(merged), [VERSION_KEY]: VERSION }, () => {
          if (lastError() || obsolete.length === 0) { callback(); return; }
          storage.local.remove(obsolete, () => callback());
        });
      };
      // A build that kept preferences locally had already copied the sync area.
      if (!storage.sync || Object.hasOwn(local ?? {}, LEGACY_LOCAL_MARKER)) { finish({}); return; }
      storage.sync.get(LEGACY_KEYS, (synced) => {
        // An unreadable sync area stays unmigrated, so a later start can copy it.
        if (lastError()) { callback(); return; }
        finish(pickLegacy(synced));
      });
    });
  }

  function load(callback) {
    const local = api()?.local;
    if (!local) { callback(sanitize({})); return; }
    local.get([...KEYS, VERSION_KEY], (stored) => {
      if (lastError()) { callback(sanitize({})); return; }
      if (stored?.[VERSION_KEY] === VERSION) { callback(sanitize(stored)); return; }
      migrate(() => local.get(KEYS, (migrated) => callback(sanitize(lastError() ? {} : migrated))));
    });
  }

  function save(settings, callback = () => {}) {
    const local = api()?.local;
    if (!local) { callback(null); return; }
    local.set({ ...pickSettings(sanitize(settings)), [VERSION_KEY]: VERSION }, () => callback(lastError()));
  }

  function hasSyncCopy(callback) {
    const sync = api()?.sync;
    if (!sync) { callback(false); return; }
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
