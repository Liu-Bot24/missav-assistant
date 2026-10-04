(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    homepageEnabled: true,
    hideUntagged: false,
    infiniteScroll: false,
    actressLimitEnabled: true,
    maxActresses: 3,
    showActressNames: true,
    blockedPresets: ["uncensored"],
    genreIncludeRules: [],
    genreExcludeRules: ["group:gender-diverse"]
  });
  let settings = { ...DEFAULT_SETTINGS };
  let discoveredTypes = [];
  let siteStatus = null;
  let metadataCacheCount = 0;
  let saveTimer;
  let readGeneration = 0;
  let metadataReadGeneration = 0;
  let readState = "loading";
  let storageMode = "local";
  let storageBusy = false;
  let saveRevision = 0;
  let savedRevision = 0;
  let saving = null;
  let saveError = null;
  let saveMessage = "正在读取设置…";
  let confirmedSettings = null;
  let storageCopies = null;
  let inspectGeneration = 0;
  let cacheClearing = false;
  let openGenrePicker = null;
  const localStorageApi = globalThis.chrome?.storage?.local;

  const elements = {
    enabled: document.querySelector("#enabled"),
    homepageEnabled: document.querySelector("#homepageEnabled"),
    hideUntagged: document.querySelector("#hideUntagged"),
    infiniteScroll: document.querySelector("#infiniteScroll"),
    actressLimitEnabled: document.querySelector("#actressLimitEnabled"),
    maxActresses: document.querySelector("#maxActresses"),
    showActressNames: document.querySelector("#showActressNames"),
    actressExplainer: document.querySelector("#actressExplainer"),
    presetInputs: [...document.querySelectorAll('input[name="preset"]')],
    genreIncludeField: document.querySelector("#genreIncludeField"),
    genreIncludeSearch: document.querySelector("#genreIncludeSearch"),
    genreIncludeSuggestions: document.querySelector("#genreIncludeSuggestions"),
    genreExcludeField: document.querySelector("#genreExcludeField"),
    genreExcludeSearch: document.querySelector("#genreExcludeSearch"),
    genreExcludeSuggestions: document.querySelector("#genreExcludeSuggestions"),
    genreCount: document.querySelector("#genreCount"),
    ruleSummary: document.querySelector("#ruleSummary"),
    siteStatus: document.querySelector("#siteStatus"),
    genreExplainer: document.querySelector("#genreExplainer"),
    statusBadge: document.querySelector("#statusBadge"),
    saveState: document.querySelector("#saveState"),
    resetButton: document.querySelector("#resetButton"),
    settingsFields: document.querySelector("#settingsFields"),
    retrySaveButton: document.querySelector("#retrySaveButton"),
    reloadSettingsButton: document.querySelector("#reloadSettingsButton"),
    storageSummary: document.querySelector("#storageSummary"),
    storageOptionsButton: document.querySelector("#storageOptionsButton"),
    storageOptions: document.querySelector("#storageOptions"),
    storageOptionsState: document.querySelector("#storageOptionsState"),
    useLocalCopyButton: document.querySelector("#useLocalCopyButton"),
    copyToLocalButton: document.querySelector("#copyToLocalButton"),
    useSyncCopyButton: document.querySelector("#useSyncCopyButton"),
    copyToSyncButton: document.querySelector("#copyToSyncButton"),
    clearCacheButton: document.querySelector("#clearCacheButton"),
    cacheState: document.querySelector("#cacheState")
  };

  function normalizeForComparison(value) {
    return String(value).normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
  }

  function sanitizeSettings(value) {
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
        ? Number(value.maxActresses) : DEFAULT_SETTINGS.maxActresses,
      showActressNames: value?.showActressNames !== false,
      blockedPresets: MissavLabelLibrary.sanitizePresets(value?.blockedPresets),
      genreIncludeRules: sanitizeGenreRules(
        value?.genreIncludeRules,
        DEFAULT_SETTINGS.genreIncludeRules
      ),
      genreExcludeRules: sanitizeGenreRules(
        value?.genreExcludeRules,
        DEFAULT_SETTINGS.genreExcludeRules
      )
    };
  }

  const settingsStore = MissavSettingsStorage.create({ defaults: DEFAULT_SETTINGS, sanitize: sanitizeSettings });
  const cloneSettings = (value) => JSON.parse(JSON.stringify(value));
  const isDirty = () => saveRevision !== savedRevision;
  const canEdit = () => readState === "ready" && storageMode !== "legacy" && !storageBusy;
  const canChangeStorage = () => readState === "ready" && !saving && !storageBusy && (!isDirty() || Boolean(saveError));

  function addGenreRule(rule, mode) {
    if (!canEdit()) return;
    settings.genreIncludeRules = settings.genreIncludeRules.filter((item) => item !== rule);
    settings.genreExcludeRules = settings.genreExcludeRules.filter((item) => item !== rule);

    if (mode === "include") settings.genreIncludeRules.push(rule);
    if (mode === "exclude") settings.genreExcludeRules.push(rule);
    persist();
  }

  function removeGenreRule(rule, mode) {
    if (!canEdit()) return;
    const key = mode === "include" ? "genreIncludeRules" : "genreExcludeRules";
    settings[key] = settings[key].filter((item) => item !== rule);
    persist();
  }

  function genrePickerElements(mode) {
    if (mode === "include") {
      return {
        field: elements.genreIncludeField,
        input: elements.genreIncludeSearch,
        suggestions: elements.genreIncludeSuggestions,
        rules: settings.genreIncludeRules
      };
    }
    return {
      field: elements.genreExcludeField,
      input: elements.genreExcludeSearch,
      suggestions: elements.genreExcludeSuggestions,
      rules: settings.genreExcludeRules
    };
  }

  function labelForRule(rule, options) {
    return options.find((option) => option.rule === rule)?.label ??
      MissavGenreLibrary.decodeValueRule(rule) ?? rule;
  }

  function matchingGenreOptions(mode, options) {
    const picker = genrePickerElements(mode);
    const query = normalizeForComparison(picker.input.value);
    return options.filter((option) =>
      !picker.rules.includes(option.rule) &&
      (!query || [option.label, ...(option.aliases ?? [])]
        .some((label) => normalizeForComparison(label).includes(query)))
    );
  }

  function renderSelectedGenreRules(mode, options) {
    const picker = genrePickerElements(mode);
    for (const chip of picker.field.querySelectorAll(".selected-genre-chip")) chip.remove();

    for (const rule of picker.rules) {
      const chip = document.createElement("span");
      chip.className = `selected-genre-chip ${mode}`;
      chip.append(document.createTextNode(labelForRule(rule, options)));

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `移除${mode === "include" ? "只显示" : "隐藏"}分类：${labelForRule(rule, options)}`);
      removeButton.addEventListener("click", () => removeGenreRule(rule, mode));
      chip.append(removeButton);
      picker.field.insertBefore(chip, picker.input);
    }

    picker.input.placeholder = picker.rules.length > 0
      ? "继续添加…"
      : "搜索并添加分类…";
  }

  function renderGenreSuggestions(mode, options) {
    const picker = genrePickerElements(mode);
    const matches = matchingGenreOptions(mode, options);
    picker.field.closest(".genre-picker").classList.toggle("is-open", openGenrePicker === mode);
    picker.suggestions.replaceChildren();

    if (openGenrePicker !== mode) {
      picker.suggestions.hidden = true;
      picker.input.setAttribute("aria-expanded", "false");
      return;
    }

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "genre-suggestion-empty";
      empty.textContent = "没有匹配的分类";
      picker.suggestions.append(empty);
    } else {
      for (const option of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `genre-suggestion${option.kind === "group" ? " is-group" : ""}`;
        button.setAttribute("role", "option");

        const copy = document.createElement("span");
        const label = document.createElement("strong");
        label.textContent = option.label;
        const description = document.createElement("small");
        description.textContent = option.description;
        copy.append(label, description);

        const addMark = document.createElement("span");
        addMark.className = "genre-add-mark";
        addMark.textContent = "+";
        addMark.setAttribute("aria-hidden", "true");
        button.append(copy, addMark);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          picker.input.value = "";
          openGenrePicker = null;
          addGenreRule(option.rule, mode);
          picker.input.blur();
        });
        picker.suggestions.append(button);
      }
    }

    picker.suggestions.hidden = false;
    picker.input.setAttribute("aria-expanded", "true");
  }

  function renderGenrePickers() {
    const options = MissavGenreLibrary.options(discoveredTypes);
    elements.genreCount.textContent = `${options.length} 类 · 已缓存 ${metadataCacheCount}`;
    for (const mode of ["include", "exclude"]) {
      renderSelectedGenreRules(mode, options);
      renderGenreSuggestions(mode, options);
    }
  }

  function render() {
    elements.enabled.checked = settings.enabled;
    elements.homepageEnabled.checked = settings.homepageEnabled;
    elements.hideUntagged.checked = settings.hideUntagged;
    elements.infiniteScroll.checked = settings.infiniteScroll;
    elements.actressLimitEnabled.checked = settings.actressLimitEnabled;
    elements.maxActresses.value = settings.maxActresses;
    elements.maxActresses.disabled = !settings.actressLimitEnabled;
    elements.showActressNames.checked = settings.showActressNames;

    for (const input of elements.presetInputs) {
      input.checked = settings.blockedPresets.includes(input.value);
    }

    elements.statusBadge.textContent = settings.enabled ? "已开启" : "已暂停";
    elements.statusBadge.classList.toggle("paused", !settings.enabled);

    const ruleCount =
      settings.blockedPresets.length +
      settings.genreIncludeRules.length +
      settings.genreExcludeRules.length +
      (settings.hideUntagged ? 1 : 0) + (settings.actressLimitEnabled ? 1 : 0);
    elements.ruleSummary.textContent = settings.enabled
      ? `当前启用 ${ruleCount} 条规则`
      : `已保留 ${ruleCount} 条规则，重新开启后生效`;

    renderSiteStatus();
    renderGenrePickers();
    renderPersistence();
  }

  function renderSiteStatus() {
    let message = "当前页面未连接，请刷新网页或检查扩展的站点访问权限。";
    if (siteStatus) {
      if (!siteStatus.compatible) message = "当前页面未识别为兼容的视频列表。";
      else if (!settings.enabled) message = "当前页面兼容，筛选已暂停。";
      else if (siteStatus.pageKind === "detail") message = "当前为播放详情页，不执行筛选。";
      else if (siteStatus.pageKind === "home" && !settings.homepageEnabled) message = "当前首页已关闭筛选，其他列表页仍按规则生效。";
      else message = siteStatus.metadata === "missav"
        ? "当前页面支持标签、分类与女优筛选。"
        : "已识别兼容模板，基础功能可用；分类与女优筛选尚未适配。";
    }
    elements.siteStatus.textContent = message;
    const basicOnly = siteStatus?.compatible && !siteStatus.metadata;
    elements.genreExplainer.textContent = basicOnly
      ? "此站尚未适配分类数据，以下条件仅在支持分类的网站生效。"
      : "按视频的内页分类筛选，隐藏条件优先。";
    elements.actressExplainer.textContent = basicOnly
      ? "此站尚未适配女优数据，以下设置在支持的网站生效。"
      : "同一演员的不同名字合并计数。";
    if (basicOnly) elements.ruleSummary.textContent = `已配置 ${settings.blockedPresets.length +
      settings.genreIncludeRules.length + settings.genreExcludeRules.length + (settings.hideUntagged ? 1 : 0) +
      (settings.actressLimitEnabled ? 1 : 0)} 条规则`;
  }

  function readSiteStatus() {
    const tabs = globalThis.chrome?.tabs;
    if (!tabs) { renderSiteStatus(); return; }
    tabs.query({ active: true, currentWindow: true }, (openTabs) => {
      if (chrome.runtime.lastError || !openTabs?.[0]?.id) { renderSiteStatus(); return; }
      tabs.sendMessage(openTabs[0].id, { type: "viewing-assistant-status" }, (response) => {
        siteStatus = chrome.runtime.lastError ? null : response ?? null;
        render();
      });
    });
  }

  function renderPersistence() {
    const dirty = isDirty();
    elements.settingsFields.disabled = !canEdit();
    elements.resetButton.disabled = !canEdit();
    elements.maxActresses.disabled = !canEdit() || !settings.actressLimitEnabled;
    elements.saveState.textContent = saveMessage;
    elements.saveState.classList.toggle("is-error", Boolean(saveError) || readState === "error");
    elements.retrySaveButton.hidden = !saveError || !dirty || readState !== "ready";
    elements.retrySaveButton.disabled = Boolean(saving) || storageBusy;
    elements.reloadSettingsButton.hidden = readState !== "error" && !saveError;
    elements.reloadSettingsButton.disabled = storageBusy || Boolean(saving);
    elements.reloadSettingsButton.textContent = dirty ? "重新读取并放弃未保存更改" : "重新读取设置";
    elements.storageOptionsButton.disabled = !canChangeStorage();
    elements.storageSummary.textContent = readState === "loading" ? "正在读取存储位置…"
      : readState === "error" ? "设置未能读取或存储位置未确认，请重试。"
      : storageMode === "legacy" ? "发现旧版同步偏好，当前仍按旧偏好生效。请明确选择存储位置后再编辑；尚未复制或删除任何副本。"
      : storageMode === "sync" ? "当前：已主动启用浏览器同步。"
      : "当前：仅本机保存，不写入浏览器同步存储。";
    for (const button of [elements.useLocalCopyButton, elements.copyToLocalButton,
      elements.useSyncCopyButton, elements.copyToSyncButton]) {
      button.disabled = !storageCopies || !canChangeStorage();
    }
    if (readState !== "ready") {
      elements.statusBadge.textContent = readState === "error" ? "未读取" : "正在读取";
      elements.ruleSummary.textContent = "尚未确认已保存的设置";
    } else if (dirty) {
      elements.statusBadge.textContent = saveError ? "未保存" : "保存中";
      elements.ruleSummary.textContent = "以下为待保存设置；网页仍使用上次成功保存的设置";
    }
  }

  function loadSettings() {
    const request = ++readGeneration;
    readState = "loading";
    saveError = null;
    saveMessage = "正在读取设置…";
    render();
    settingsStore.read((error, snapshot) => {
      if (request !== readGeneration) return;
      if (error) {
        readState = "error";
        saveMessage = `读取失败，尚未更改设置：${error.message}`;
      } else {
        settings = sanitizeSettings(snapshot.settings);
        confirmedSettings = cloneSettings(settings);
        storageMode = snapshot.mode;
        readState = "ready";
        saveRevision = savedRevision = 0;
        saveMessage = storageMode === "legacy" ? "请先选择偏好存储位置"
          : `更改后自动保存到${storageMode === "sync" ? "同步存储" : "本机"}`;
      }
      render();
      if (!error && storageMode === "legacy") showStorageOptions();
    });
  }

  function drainSave() {
    clearTimeout(saveTimer);
    if (saving || !isDirty() || !canEdit() || saveError) return;
    const operation = { revision: saveRevision, value: cloneSettings(settings) };
    saving = operation;
    settingsStore.save(operation.value, storageMode, (error, snapshot) => {
      if (saving !== operation) return;
      saving = null;
      if (error) {
        saveError = error;
        if (error.modeChanged) readState = "error";
        saveMessage = `未保存，网页仍使用上次成功保存的设置：${error.message}`;
      } else {
        confirmedSettings = cloneSettings(snapshot.settings);
        savedRevision = operation.revision;
        saveMessage = isDirty() ? "仍有更改待保存…" : "已保存，页面将自动更新";
      }
      render();
      if (!error && isDirty()) drainSave();
    });
  }

  function persist() {
    if (!canEdit()) {
      settings = sanitizeSettings(confirmedSettings ?? DEFAULT_SETTINGS);
      render();
      return;
    }
    settings = sanitizeSettings(settings);
    saveRevision += 1;
    saveError = null;
    saveMessage = "正在保存；完成前请保持弹窗打开…";
    clearTimeout(saveTimer);
    render();
    // Collapse a burst of toggles into one write; never overlap writes. A late
    // callback cannot claim success for newer, still-unwritten edits.
    saveTimer = setTimeout(drainSave, 150);
  }

  function showStorageOptions() {
    if (!canChangeStorage()) return;
    const request = ++inspectGeneration;
    elements.storageOptions.hidden = false;
    elements.storageOptionsButton.setAttribute("aria-expanded", "true");
    elements.storageOptionsState.textContent = "正在检查已有副本…";
    storageCopies = null;
    renderPersistence();
    settingsStore.inspect((error, copies) => {
      if (request !== inspectGeneration) return;
      storageCopies = error ? null : copies;
      elements.storageOptionsState.textContent = error ? `无法检查副本：${error.message}`
        : `本机副本：${copies.local ? "存在" : "无"}；同步副本：${copies.sync ? "存在" : "无"}。`;
      elements.useLocalCopyButton.hidden = !copies?.local;
      elements.useSyncCopyButton.hidden = !copies?.sync;
      renderPersistence();
    });
  }

  function selectStorage(mode, source) {
    if (!storageCopies || !canChangeStorage()) return;
    const destination = mode === "sync" ? "浏览器同步存储" : "本机存储";
    const warning = source === "current"
      ? `将当前全部筛选偏好保存到${destination}，并替换那里已有的设置副本。`
      : `使用${destination}中现有的设置，替换当前界面使用的偏好。`;
    const privacy = mode === "sync"
      ? "标签、分类与人数阈值等偏好在浏览器同步开启时可传到同账号设备；后续编辑也会同步。"
      : "此设备此后仅使用本机副本。旧同步副本不会删除，其他设备的设置不会改变。";
    if (!globalThis.confirm(`${warning}\n${privacy}\n继续吗？`)) return;
    storageBusy = true;
    clearTimeout(saveTimer);
    saveMessage = "正在切换存储位置，请保持弹窗打开…";
    renderPersistence();
    settingsStore.select(mode, source, cloneSettings(settings), (error, snapshot) => {
      storageBusy = false;
      if (error) {
        // A failed mode switch can follow a successful sync upload. Do not
        // retry the upload automatically or report an unqualified failure.
        readState = "error";
        saveMessage = `切换未完成：${error.message}`;
      } else {
        storageMode = snapshot.mode;
        settings = sanitizeSettings(snapshot.settings);
        confirmedSettings = cloneSettings(settings);
        saveError = null;
        savedRevision = saveRevision;
        saveMessage = `已选择${storageMode === "sync" ? "同步" : "仅本机"}保存，页面将自动更新`;
        elements.storageOptions.hidden = true;
        elements.storageOptionsButton.setAttribute("aria-expanded", "false");
      }
      render();
    });
  }

  elements.retrySaveButton.addEventListener("click", () => {
    if (!canEdit() || saving) return;
    saveError = null;
    saveMessage = "正在重试保存…";
    render();
    drainSave();
  });
  elements.reloadSettingsButton.addEventListener("click", () => {
    if (storageBusy || saving) return;
    if (isDirty() && !globalThis.confirm("放弃当前未保存的更改，重新读取已保存的设置？")) return;
    clearTimeout(saveTimer);
    loadSettings();
  });
  elements.storageOptionsButton.addEventListener("click", showStorageOptions);
  elements.useLocalCopyButton.addEventListener("click", () => selectStorage("local", "existing"));
  elements.copyToLocalButton.addEventListener("click", () => selectStorage("local", "current"));
  elements.useSyncCopyButton.addEventListener("click", () => selectStorage("sync", "existing"));
  elements.copyToSyncButton.addEventListener("click", () => selectStorage("sync", "current"));

  elements.enabled.addEventListener("change", () => {
    settings.enabled = elements.enabled.checked;
    persist();
  });

  elements.hideUntagged.addEventListener("change", () => {
    settings.hideUntagged = elements.hideUntagged.checked;
    persist();
  });

  elements.homepageEnabled.addEventListener("change", () => {
    settings.homepageEnabled = elements.homepageEnabled.checked;
    persist();
  });

  elements.infiniteScroll.addEventListener("change", () => {
    settings.infiniteScroll = elements.infiniteScroll.checked;
    persist();
  });

  elements.actressLimitEnabled.addEventListener("change", () => {
    settings.actressLimitEnabled = elements.actressLimitEnabled.checked;
    persist();
  });

  elements.showActressNames.addEventListener("change", () => {
    settings.showActressNames = elements.showActressNames.checked;
    persist();
  });

  elements.maxActresses.addEventListener("change", () => {
    if (!elements.maxActresses.checkValidity() || elements.maxActresses.value === "") {
      elements.maxActresses.reportValidity();
      elements.maxActresses.value = settings.maxActresses;
      return;
    }
    settings.maxActresses = Number(elements.maxActresses.value);
    persist();
  });

  for (const input of elements.presetInputs) {
    input.addEventListener("change", () => {
      settings.blockedPresets = elements.presetInputs
        .filter((item) => item.checked)
        .map((item) => item.value);
      persist();
    });
  }

  for (const mode of ["include", "exclude"]) {
    const picker = genrePickerElements(mode);
    picker.input.addEventListener("focus", () => {
      openGenrePicker = mode;
      renderGenrePickers();
    });
    picker.input.addEventListener("input", () => {
      openGenrePicker = mode;
      renderGenrePickers();
    });
    picker.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        openGenrePicker = null;
        renderGenrePickers();
        picker.input.blur();
        return;
      }
      if (event.key !== "Enter") return;
      const first = matchingGenreOptions(mode, MissavGenreLibrary.options(discoveredTypes))[0];
      if (!first) return;
      event.preventDefault();
      picker.input.value = "";
      openGenrePicker = null;
      addGenreRule(first.rule, mode);
      picker.input.blur();
    });
  }

  document.addEventListener("mousedown", (event) => {
    if (event.target.closest(".genre-picker")) return;
    openGenrePicker = null;
    renderGenrePickers();
  });

  elements.resetButton.addEventListener("click", () => {
    settings = {
      ...DEFAULT_SETTINGS,
      blockedPresets: [...DEFAULT_SETTINGS.blockedPresets],
      genreIncludeRules: [],
      genreExcludeRules: [...DEFAULT_SETTINGS.genreExcludeRules]
    };
    persist();
  });

  loadSettings();

  readSiteStatus();

  if (localStorageApi?.get) {
    const request = metadataReadGeneration;
    try {
      localStorageApi.get({ discoveredTypes: [], metadataCacheCount: 0 }, (stored) => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error || request !== metadataReadGeneration || !stored) return;
      discoveredTypes = Array.isArray(stored.discoveredTypes) ? stored.discoveredTypes : [];
      metadataCacheCount = Number.isFinite(Number(stored.metadataCacheCount))
        ? Number(stored.metadataCacheCount)
        : 0;
      renderGenrePickers();
      });
    } catch {
      elements.cacheState.textContent = "缓存统计暂时无法读取";
    }
  }

  elements.clearCacheButton.addEventListener("click", () => {
    if (cacheClearing) return;
    cacheClearing = true;
    elements.clearCacheButton.disabled = true;
    elements.cacheState.classList.remove("is-error");
    elements.cacheState.textContent = "正在清除缓存…";
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cacheClearing = false;
      elements.clearCacheButton.disabled = false;
      elements.cacheState.classList.toggle("is-error", Boolean(error));
      elements.cacheState.textContent = error ? `清除失败：${error.message}`
        : "缓存、已发现分类与计数已清除；后续查询会重新缓存";
      if (!error) {
        metadataReadGeneration += 1;
        discoveredTypes = [];
        metadataCacheCount = 0;
        renderGenrePickers();
      }
    };
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) throw new Error("后台通信不可用，请重新打开扩展后重试");
      runtime.sendMessage({ type: "missav-clear-metadata-cache" }, (response) => {
        const error = runtime.lastError;
        finish(error ? new Error(error.message || "后台通信失败")
          : response?.ok === true ? null : new Error(response?.error || "后台未确认清除成功"));
      });
    } catch (error) { finish(error); }
  });

  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.discoveredTypes || changes.metadataCacheCount) metadataReadGeneration += 1;
    if (changes.discoveredTypes) {
      discoveredTypes = Array.isArray(changes.discoveredTypes.newValue)
        ? changes.discoveredTypes.newValue
        : [];
    }
    if (changes.metadataCacheCount) {
      metadataCacheCount = Number.isFinite(Number(changes.metadataCacheCount.newValue))
        ? Number(changes.metadataCacheCount.newValue)
        : 0;
    }
    if (!changes.discoveredTypes && !changes.metadataCacheCount) return;
    renderGenrePickers();
  });
})();
