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
  // Until 1.2.0 some lookup features were on by default. An update keeps the
  // defaults of the version it replaces for preferences never set, so filtering
  // the user relied on does not stop and features they never had stay off.
  const EARLIER_DEFAULTS_UNTIL = "1.2.0";
  const PERFORMER_FEATURES_SINCE = "1.0.1";
  const EARLIER_DEFAULT_KEYS = Object.freeze(["actressLimitEnabled", "showActressNames", "categoryExcludeRules"]);
  function earlierDefaults(version) {
    // All three are written, off as well as on, so completing again changes nothing.
    const performers = !isEarlierVersion(version, PERFORMER_FEATURES_SINCE);
    return { categoryExcludeRules: ["group:gender-diverse"], actressLimitEnabled: performers, showActressNames: performers };
  }
  // What 1.0.x left in local storage once it had looked videos up.
  const EARLIER_CACHE = "videoMetadataById";
  const EARLIER_CATEGORIES = "discoveredTypes";
  // Replacing the files and restarting the browser sends no update event, so
  // migration recognizes the earlier version by those traces. 1.0.0 cached every
  // video it took categories from, without performers. 1.0.1 drops such records
  // whenever it writes the cache, and may note categories without caching.
  function versionFromTraces(local) {
    const cache = local?.[EARLIER_CACHE];
    if (!cache && !local?.[EARLIER_CATEGORIES]) return null;
    const withoutPerformers = Object.values(cache ?? {}).some((record) => record && !Object.hasOwn(record, "actresses"));
    return withoutPerformers ? "1.0.0" : PERFORMER_FEATURES_SINCE;
  }
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
  // Runs a storage call once more if it failed; the second outcome stands.
  const twice = (call) => (argument, callback) => call(argument, (value) => {
    if (lastError()) call(argument, callback);
    else callback(value);
  });

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
  // The version seen in the traces is marked first: the background clears them,
  // and migration may have to be retried after that. It is written again with
  // the settings version, in case marking failed.
  function migrate(callback = () => {}) {
    const storage = api();
    if (!storage?.local) { callback(false); return; }
    let traced = null;
    const done = (ok) => callback(ok);
    storage.local.get([...new Set([...KEYS, ...LEGACY_KEYS, LEGACY_LOCAL_MARKER, VERSION_KEY, ...EARLIER_VERSION_MARKS, EARLIER_CACHE, EARLIER_CATEGORIES])], (local) => {
      if (lastError()) { done(false); return; }
      if (local?.[VERSION_KEY] === VERSION) { done(true); return; }
      const finish = (synced) => {
        const merged = upgradeValues({ ...synced, ...pickLegacy(local), ...pickSettings(local) });
        const obsolete = [...Object.values(LEGACY_NAMES), LEGACY_LOCAL_MARKER]
          .filter((key) => Object.hasOwn(local ?? {}, key));
        // Another page or the background may have finished first; its result,
        // and anything saved since, must not be overwritten with this snapshot.
        storage.local.get([...KEYS, VERSION_KEY], (current) => {
          if (lastError()) { done(false); return; }
          if (current?.[VERSION_KEY] === VERSION) { done(true); return; }
          const mark = traced ? { [EARLIER_VERSION_TRACED]: traced } : {};
          storage.local.set({ ...pickSettings(merged), ...pickSettings(current), ...mark, [VERSION_KEY]: VERSION }, () => {
            if (lastError()) { done(false); return; }
            if (obsolete.length === 0) { done(true); return; }
            storage.local.remove(obsolete, () => done(true));
          });
        });
      };
      const copy = () => {
        if (!storage.sync) { finish({}); return; }
        storage.sync.get(LEGACY_KEYS, (synced) => {
          if (lastError()) {
            // A build that kept preferences locally had already copied the sync
            // area; otherwise leave it unmigrated so a later start can copy it.
            if (Object.hasOwn(local ?? {}, LEGACY_LOCAL_MARKER)) finish({});
            else done(false);
            return;
          }
          finish(pickLegacy(synced));
        });
      };
      traced = markedVersion(local) ? null : versionFromTraces(local);
      if (!traced) { copy(); return; }
      storage.local.set({ [EARLIER_VERSION_TRACED]: traced }, () => copy());
    });
  }

  const isEarlierVersion = (version, than) => {
    const parts = (value) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const [left, right] = [parts(version), parts(than)];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0);
    }
    return false;
  };

  // The replaced version: from the update event until its defaults are written,
  // or as guessed from the traces. A guess only stands in for missing values and
  // is never stored as preferences, since a page can load before the event comes.
  const EARLIER_DEFAULTS_PENDING = "earlierDefaultsPending";
  const EARLIER_VERSION_TRACED = "earlierVersionTraced";
  const EARLIER_VERSION_MARKS = Object.freeze([EARLIER_DEFAULTS_PENDING, EARLIER_VERSION_TRACED]);
  const markedVersion = (values) => values?.[EARLIER_DEFAULTS_PENDING] ?? values?.[EARLIER_VERSION_TRACED];
  const withEarlierDefaults = (version, value) => ({ ...earlierDefaults(version), ...value });

  // One failed call must not leave rules unread: the popup would show empty
  // lists, and adding to one would replace the rules not yet copied.
  function migrateWithRetry(callback) {
    migrate((ok) => {
      if (ok) callback(ok);
      else migrate(callback);
    });
  }

  // Migrates, then writes the earlier defaults of a version an event gave for
  // preferences never stored, and only then clears the marks; stored values,
  // including false and empty lists, stay.
  // On any failure the mark stays and a later load retries.
  // `updatedFrom` is given while the update itself runs, in case writing the mark failed.
  function completeEarlierDefaults(callback = () => {}, updatedFrom = null) {
    migrateWithRetry((ok) => {
      const local = api()?.local;
      if (!ok || !local) { callback(ok); return; }
      const [read, write] = [twice(local.get.bind(local)), twice(local.set.bind(local))];
      read([...EARLIER_DEFAULT_KEYS, ...EARLIER_VERSION_MARKS], (stored) => {
        if (lastError()) { callback(true); return; }
        const version = updatedFrom ?? stored?.[EARLIER_DEFAULTS_PENDING];
        if (!version) { callback(true); return; }
        const missing = Object.fromEntries(Object.entries(earlierDefaults(version))
          .filter(([key]) => !Object.hasOwn(stored, key)));
        write(missing, () => {
          if (lastError()) { callback(true); return; }
          local.remove([...EARLIER_VERSION_MARKS], () => callback(true));
        });
      });
    });
  }

  // Runs when the extension is installed or updated.
  function handleInstalled(details, callback = () => {}) {
    const local = api()?.local;
    const fromEarlier = details?.reason === "update" && isEarlierVersion(details.previousVersion, EARLIER_DEFAULTS_UNTIL);
    if (!fromEarlier || !local) { completeEarlierDefaults(callback); return; }
    const version = details.previousVersion;
    local.set({ [EARLIER_DEFAULTS_PENDING]: version }, () => completeEarlierDefaults(callback, version));
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
    // Earlier local values still count until migration completes. Earlier
    // defaults stand in for missing values only after it: before that, unread is
    // not unset, and they could turn on lookups the user had turned off.
    const merge = (values, isMigrated) => {
      const value = isMigrated ? pickSettings(values) : upgradeValues({ ...pickLegacy(values), ...pickSettings(values) });
      const version = values?.[VERSION_KEY] === VERSION ? markedVersion(values) : null;
      return version ? withEarlierDefaults(version, value) : value;
    };
    const keys = [...KEYS, ...LEGACY_KEYS, VERSION_KEY, ...EARLIER_VERSION_MARKS];
    twice(local.get.bind(local))(keys, (stored) => {
      if (lastError()) { done({}, false); return; }
      if (stored?.[VERSION_KEY] === VERSION && !stored[EARLIER_DEFAULTS_PENDING]) { done(merge(stored, true), true); return; }
      completeEarlierDefaults((ok) => {
        // The read after migration is tried twice; if both fail, the values read
        // before it stand, reported as not migrated.
        const reread = (attemptsLeft) => local.get(keys, (current) => {
          if (!lastError()) { done(merge(current, ok), ok); return; }
          if (attemptsLeft > 0) { reread(attemptsLeft - 1); return; }
          done(merge(stored, false), false);
        });
        reread(1);
      });
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
    DEFAULTS, KEYS, sanitize, load, save, migrate, handleInstalled, hasSyncCopy, removeSyncCopy, changedSettings
  });
})();
