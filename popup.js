(() => {
  "use strict";

  const DEFAULT_SETTINGS = SettingsStore.DEFAULTS;
  const sanitizeSettings = SettingsStore.sanitize;
  let settings = sanitizeSettings(DEFAULT_SETTINGS);
  let discoveredCategories = [];
  let siteStatus = null;
  let saveTimer;
  // The settings before the last reset, while it can still be undone.
  let undoSettings = null;
  let undoTimer;
  let openCategoryPicker = null;
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
    labelInputs: [...document.querySelectorAll('input[name="hiddenLabel"]')],
    categoryIncludeField: document.querySelector("#categoryIncludeField"),
    categoryIncludeSearch: document.querySelector("#categoryIncludeSearch"),
    categoryIncludeSuggestions: document.querySelector("#categoryIncludeSuggestions"),
    categoryExcludeField: document.querySelector("#categoryExcludeField"),
    categoryExcludeSearch: document.querySelector("#categoryExcludeSearch"),
    categoryExcludeSuggestions: document.querySelector("#categoryExcludeSuggestions"),
    categoryCount: document.querySelector("#categoryCount"),
    ruleSummary: document.querySelector("#ruleSummary"),
    siteStatus: document.querySelector("#siteStatus"),
    categoryExplainer: document.querySelector("#categoryExplainer"),
    statusBadge: document.querySelector("#statusBadge"),
    saveState: document.querySelector("#saveState"),
    resetButton: document.querySelector("#resetButton"),
    syncNotice: document.querySelector("#syncNotice"),
    removeSyncCopy: document.querySelector("#removeSyncCopy")
  };

  // Stored as category -> number of videos seen with it.
  // Most used first; the picker offers the most used ones.
  const MAX_OFFERED_CATEGORIES = 500;
  function categoryList(counts) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) return [];
    return Object.entries(counts)
      .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0], "zh-CN"))
      .slice(0, MAX_OFFERED_CATEGORIES)
      .map(([value]) => value);
  }

  const normalizeForComparison = TextKey.normalize;

  function addCategoryRule(rule, mode) {
    settings.categoryIncludeRules = settings.categoryIncludeRules.filter((item) => item !== rule);
    settings.categoryExcludeRules = settings.categoryExcludeRules.filter((item) => item !== rule);

    if (mode === "include") settings.categoryIncludeRules.push(rule);
    if (mode === "exclude") settings.categoryExcludeRules.push(rule);
    persist();
  }

  function removeCategoryRule(rule, mode) {
    const key = mode === "include" ? "categoryIncludeRules" : "categoryExcludeRules";
    settings[key] = settings[key].filter((item) => item !== rule);
    persist();
  }

  function categoryPickerElements(mode) {
    if (mode === "include") {
      return {
        field: elements.categoryIncludeField,
        input: elements.categoryIncludeSearch,
        suggestions: elements.categoryIncludeSuggestions,
        rules: settings.categoryIncludeRules
      };
    }
    return {
      field: elements.categoryExcludeField,
      input: elements.categoryExcludeSearch,
      suggestions: elements.categoryExcludeSuggestions,
      rules: settings.categoryExcludeRules
    };
  }

  function labelForRule(rule, options) {
    return options.find((option) => option.rule === rule)?.label ??
      CategoryLibrary.decodeValueRule(rule) ?? rule;
  }

  function matchingCategoryOptions(mode, options) {
    const picker = categoryPickerElements(mode);
    const query = normalizeForComparison(picker.input.value);
    return options.filter((option) =>
      !picker.rules.includes(option.rule) &&
      (!query || [option.label, ...(option.aliases ?? [])]
        .some((label) => normalizeForComparison(label).includes(query)))
    );
  }

  function renderSelectedCategoryRules(mode, options) {
    const picker = categoryPickerElements(mode);
    for (const chip of picker.field.querySelectorAll(".selected-category-chip")) chip.remove();

    for (const rule of picker.rules) {
      const chip = document.createElement("span");
      chip.className = `selected-category-chip ${mode}`;
      chip.append(document.createTextNode(labelForRule(rule, options)));

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = "×";
      removeButton.setAttribute("aria-label", `移除${mode === "include" ? "只显示" : "隐藏"}分类：${labelForRule(rule, options)}`);
      removeButton.addEventListener("click", () => removeCategoryRule(rule, mode));
      chip.append(removeButton);
      picker.field.insertBefore(chip, picker.input);
    }

    picker.input.placeholder = picker.rules.length > 0
      ? "继续添加…"
      : "搜索并添加分类…";
  }

  function renderCategorySuggestions(mode, options) {
    const picker = categoryPickerElements(mode);
    const matches = matchingCategoryOptions(mode, options);
    picker.field.closest(".category-picker").classList.toggle("is-open", openCategoryPicker === mode);
    picker.suggestions.replaceChildren();

    if (openCategoryPicker !== mode) {
      picker.suggestions.hidden = true;
      picker.input.setAttribute("aria-expanded", "false");
      return;
    }

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.className = "category-suggestion-empty";
      empty.textContent = "没有匹配的分类";
      picker.suggestions.append(empty);
    } else {
      for (const option of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `category-suggestion${option.kind === "group" ? " is-group" : ""}`;
        button.setAttribute("role", "option");

        const copy = document.createElement("span");
        const label = document.createElement("strong");
        label.textContent = option.label;
        copy.append(label);
        if (option.description) {
          const description = document.createElement("small");
          description.textContent = option.description;
          copy.append(description);
        }

        const addMark = document.createElement("span");
        addMark.className = "category-add-mark";
        addMark.textContent = "+";
        addMark.setAttribute("aria-hidden", "true");
        button.append(copy, addMark);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          picker.input.value = "";
          openCategoryPicker = null;
          addCategoryRule(option.rule, mode);
          picker.input.blur();
        });
        picker.suggestions.append(button);
      }
    }

    picker.suggestions.hidden = false;
    picker.input.setAttribute("aria-expanded", "true");
  }

  function renderCategoryPickers() {
    const options = CategoryLibrary.options(discoveredCategories);
    elements.categoryCount.textContent = `${options.length} 类可选`;
    for (const mode of ["include", "exclude"]) {
      renderSelectedCategoryRules(mode, options);
      renderCategorySuggestions(mode, options);
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

    for (const input of elements.labelInputs) {
      input.checked = settings.hiddenLabels.includes(input.value);
    }

    elements.statusBadge.textContent = settings.enabled ? "已开启" : "已暂停";
    elements.statusBadge.classList.toggle("paused", !settings.enabled);

    const ruleCount =
      settings.hiddenLabels.length +
      settings.categoryIncludeRules.length +
      settings.categoryExcludeRules.length +
      (settings.hideUntagged ? 1 : 0) + (settings.actressLimitEnabled ? 1 : 0);
    elements.ruleSummary.textContent = settings.enabled
      ? `当前启用 ${ruleCount} 条规则`
      : `已保留 ${ruleCount} 条规则，重新开启后生效`;

    renderSiteStatus();
    renderCategoryPickers();
  }

  function renderSiteStatus() {
    let message = "当前页面未连接，请刷新网页或检查扩展的站点访问权限。";
    if (siteStatus) {
      if (!siteStatus.compatible) message = "当前页面不是可筛选的视频列表。";
      else if (!settings.enabled) message = "筛选已暂停。";
      else if (siteStatus.pageKind === "detail") message = "播放页不做筛选。";
      else if (siteStatus.pageKind === "home" && !settings.homepageEnabled) message = "当前首页已关闭筛选，其他列表页仍按规则生效。";
      else message = siteStatus.metadata === "missav"
        ? "当前页面支持标签、分类与女优筛选。"
        : "这个网站可以按标签筛选；分类和女优功能只在 MissAV 上可用。";
    }
    elements.siteStatus.textContent = message;
    const basicOnly = siteStatus?.compatible && !siteStatus.metadata;
    elements.categoryExplainer.textContent = basicOnly
      ? "这个网站没有分类数据，以下条件只在 MissAV 上生效。"
      : "按视频详情页上的分类筛选，隐藏条件优先。";
    elements.actressExplainer.textContent = basicOnly
      ? "这个网站没有女优数据，以下设置只在 MissAV 上生效。"
      : "同一演员的不同名字合并计数。";
    if (basicOnly) elements.ruleSummary.textContent = `已保存 ${settings.hiddenLabels.length +
      settings.categoryIncludeRules.length + settings.categoryExcludeRules.length + (settings.hideUntagged ? 1 : 0) +
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

  function showSaveState(message, sticky = false) {
    elements.saveState.textContent = message;
    clearTimeout(saveTimer);
    if (sticky) return;
    saveTimer = setTimeout(() => {
      elements.saveState.textContent = "设置自动保存";
    }, 1600);
  }

  function endUndo() {
    undoSettings = null;
    clearTimeout(undoTimer);
    elements.resetButton.textContent = "恢复默认";
  }

  function persist(savedMessage = "已保存，页面将自动更新", keepUndo = false) {
    if (!keepUndo) endUndo();
    settings = sanitizeSettings(settings);
    render();
    SettingsStore.save(settings, (error) => {
      if (error) showSaveState("保存失败，请再改一次", true);
      else showSaveState(savedMessage, keepUndo);
    });
  }

  function readSyncCopy() {
    SettingsStore.hasSyncCopy((present) => { elements.syncNotice.hidden = !present; });
  }

  elements.removeSyncCopy.addEventListener("click", () => {
    elements.removeSyncCopy.disabled = true;
    SettingsStore.removeSyncCopy((error) => {
      elements.removeSyncCopy.disabled = false;
      if (error) {
        showSaveState("删除失败，请稍后重试", true);
        return;
      }
      elements.syncNotice.hidden = true;
      showSaveState("已删除账号中的旧副本");
    });
  });

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

  for (const input of elements.labelInputs) {
    input.addEventListener("change", () => {
      settings.hiddenLabels = elements.labelInputs
        .filter((item) => item.checked)
        .map((item) => item.value);
      persist();
    });
  }

  for (const mode of ["include", "exclude"]) {
    const picker = categoryPickerElements(mode);
    picker.input.addEventListener("focus", () => {
      openCategoryPicker = mode;
      renderCategoryPickers();
    });
    picker.input.addEventListener("input", () => {
      openCategoryPicker = mode;
      renderCategoryPickers();
    });
    picker.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        openCategoryPicker = null;
        renderCategoryPickers();
        picker.input.blur();
        return;
      }
      if (event.key !== "Enter") return;
      const first = matchingCategoryOptions(mode, CategoryLibrary.options(discoveredCategories))[0];
      if (!first) return;
      event.preventDefault();
      picker.input.value = "";
      openCategoryPicker = null;
      addCategoryRule(first.rule, mode);
      picker.input.blur();
    });
  }

  document.addEventListener("mousedown", (event) => {
    if (event.target.closest(".category-picker")) return;
    openCategoryPicker = null;
    renderCategoryPickers();
  });

  elements.resetButton.addEventListener("click", () => {
    if (undoSettings) {
      settings = undoSettings;
      persist("已撤销，设置已还原");
      return;
    }
    const previous = structuredClone(settings);
    settings = {
      ...DEFAULT_SETTINGS,
      hiddenLabels: [...DEFAULT_SETTINGS.hiddenLabels],
      categoryIncludeRules: [],
      categoryExcludeRules: [...DEFAULT_SETTINGS.categoryExcludeRules]
    };
    persist("已恢复默认设置", true);
    undoSettings = previous;
    elements.resetButton.textContent = "撤销";
    undoTimer = setTimeout(() => {
      endUndo();
      showSaveState("设置自动保存");
    }, 10000);
  });

  SettingsStore.load((storedSettings) => {
    settings = storedSettings;
    render();
    readSyncCopy();
  });

  readSiteStatus();

  if (localStorageApi) {
    localStorageApi.get({ discoveredCategories: {} }, (stored) => {
      discoveredCategories = categoryList(stored.discoveredCategories);
      renderCategoryPickers();
    });
  }

  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.discoveredCategories) return;
    discoveredCategories = categoryList(changes.discoveredCategories.newValue);
    renderCategoryPickers();
  });
})();
