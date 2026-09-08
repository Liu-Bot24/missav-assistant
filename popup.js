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
  let openGenrePicker = null;
  const syncStorage = globalThis.chrome?.storage?.sync;
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
    resetButton: document.querySelector("#resetButton")
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

  function addGenreRule(rule, mode) {
    settings.genreIncludeRules = settings.genreIncludeRules.filter((item) => item !== rule);
    settings.genreExcludeRules = settings.genreExcludeRules.filter((item) => item !== rule);

    if (mode === "include") settings.genreIncludeRules.push(rule);
    if (mode === "exclude") settings.genreExcludeRules.push(rule);
    persist();
  }

  function removeGenreRule(rule, mode) {
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
    if (basicOnly) elements.ruleSummary.textContent = `已保存 ${settings.blockedPresets.length +
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

  function persist() {
    settings = sanitizeSettings(settings);
    render();
    const finishSave = () => {
      elements.saveState.textContent = "已保存，页面将自动更新";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        elements.saveState.textContent = "设置自动保存";
      }, 1600);
    };

    if (syncStorage) syncStorage.set(settings, finishSave);
    else finishSave();
  }

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

  if (syncStorage) {
    syncStorage.get(DEFAULT_SETTINGS, (storedSettings) => {
      settings = sanitizeSettings(storedSettings);
      render();
    });
  } else {
    render();
  }

  readSiteStatus();

  if (localStorageApi) {
    localStorageApi.get({ discoveredTypes: [], metadataCacheCount: 0 }, (stored) => {
      discoveredTypes = Array.isArray(stored.discoveredTypes) ? stored.discoveredTypes : [];
      metadataCacheCount = Number.isFinite(Number(stored.metadataCacheCount))
        ? Number(stored.metadataCacheCount)
        : 0;
      renderGenrePickers();
    });
  }

  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
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
