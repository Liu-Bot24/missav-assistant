(() => {
  "use strict";

  let site;
  const DEFAULT_SETTINGS = SettingsStore.DEFAULTS;
  const sanitizeSettings = SettingsStore.sanitize;
  const LIST_ROUTE_SEGMENTS = new Set([
    "actress", "actresses", "genre", "genres", "label", "labels",
    "maker", "makers", "search", "series", "tag", "tags"
  ]);
  const HIDDEN_CLASS = "viewing-assistant-hidden";
  const LABEL_HIDDEN_CLASS = "viewing-assistant-label-hidden";
  const CATEGORY_HIDDEN_CLASS = "viewing-assistant-category-hidden";
  const ACTRESS_NAMES_CLASS = "viewing-assistant-names";
  const ACTRESS_HOST_CLASS = "viewing-assistant-names-host";
  const PENDING_CLASS = "viewing-assistant-pending";
  const UNVERIFIED_CLASS = "viewing-assistant-unverified";
  const SETTLING_GRID_CLASS = "viewing-assistant-grid-settling";
  const BUSY_CONTROL_CLASS = "viewing-assistant-control-busy";
  const REFILL_ATTRIBUTE = "data-viewing-assistant-refill";
  const MAX_REFILL_PAGES = 8;
  const MAX_HOME_REFILL_CLICKS = 8;
  const MAX_CONCURRENT_HOME_REFILLS = 1;
  const MIN_HOME_VISIBLE_ITEMS = 8;
  const HOME_REFILL_ACK_TIMEOUT_MS = 500;
  const HOME_REFILL_RESPONSE_TIMEOUT_MS = 15000;
  const HOME_GRID_REVEAL_QUIET_MS = 1800;
  const OBSERVED_ATTRIBUTES = ["style", "class", "hidden", "href"];
  const OWN_CLASSES = new Set([HIDDEN_CLASS, LABEL_HIDDEN_CLASS, CATEGORY_HIDDEN_CLASS,
    ACTRESS_NAMES_CLASS, ACTRESS_HOST_CLASS, PENDING_CLASS, UNVERIFIED_CLASS,
    SETTLING_GRID_CLASS, BUSY_CONTROL_CLASS]);
  const PAGE_REQUEST_TIMEOUT_MS = 15000;
  const MAX_CACHED_PAGES = MAX_REFILL_PAGES * 2;
  const pageHtmlCache = new Map();
  const pageRequests = new Set();
  const metadataClient = MetadataClient.create({ query: sendMetadataQuery });
  // Only cards whose data changed are re-checked; settings, page load and
  // navigation re-check the whole page.
  const changedMetadataIds = new Set();
  let fullScanPending = true;
  let lastScannedUrl = null;
  metadataClient.subscribe((ids) => {
    for (const id of ids) changedMetadataIds.add(id);
    scheduleScan();
  });
  const metadataNotices = new Map();
  const stalledPageIds = new Set();
  const cardSettledRevisions = new WeakMap();
  const homeGridPending = new WeakSet();
  const homeGridRequestTokens = new WeakMap();
  const homeGridAttempts = new WeakMap();
  const homeGridControls = new WeakMap();
  const homeGridActivityVersions = new WeakMap();
  const homeGridRevealTimers = new WeakMap();
  const gridCardCounts = new WeakMap();
  let topologyRevision = 0;
  let activeHomeRefills = 0;
  let settings = { ...DEFAULT_SETTINGS };
  let scanScheduled = false;
  let observerStarted = false;
  let workLoopRunning = false;
  let workRequested = false;
  let filterRevision = 0;
  let infiniteObserver = null;
  let infiniteSentinel = null;
  let infiniteGrid = null;
  let infiniteNextPageUrl = null;
  let infiniteLoading = false;
  let infiniteLoadToken = null;
  let infiniteNeedsRetry = false;
  let infiniteSeenCardKeys = new Set();
  let paginationTask = null;
  let paginationNeedsRetry = false;
  let paginationRunKey = null;
  // Set when the page limit was reached without filling the grid; the notice continues from here.
  let paginationResumeUrl = null;

  const normalizeText = TextKey.normalize;

  function isVideoDetailPage(url = location.href) {
    try {
      const segments = new URL(url).pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLocaleLowerCase());
      const slug = segments.at(-1) ?? "";
      if (!SiteLibrary.VIDEO_ID.test(slug)) return false;
      return !segments.slice(0, -1).some((segment) => LIST_ROUTE_SEGMENTS.has(segment));
    } catch {
      return false;
    }
  }

  function isHomePage(url = location.href) {
    try {
      const segments = new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
      if (/^dm\d+$/.test(segments[0] ?? "")) segments.shift();
      if (["cn", "en", "ja", "ko", "ms", "th", "de", "fr", "vi", "id", "fil", "pt"].includes(segments[0])) {
        segments.shift();
      }
      return segments.length === 0;
    } catch {
      return false;
    }
  }

  function isFilteringActive() {
    return settings.enabled && !isVideoDetailPage() && (settings.homepageEnabled || !isHomePage());
  }

  function isBadge(element) {
    return (
      element?.tagName === "SPAN" &&
      ((element.classList.contains("bottom-1") && element.classList.contains("left-1")) ||
        element.classList.contains("badge"))
    );
  }

  function isBadgeLayerVisible(badge, card, useComputedStyles = true) {
    let current = badge;

    while (current && current !== card) {
      if (
        current.hidden ||
        current.classList.contains("hidden") ||
        current.style.display === "none" ||
        current.style.visibility === "hidden" ||
        current.style.opacity === "0"
      ) {
        return false;
      }

      if (useComputedStyles) {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          return false;
        }
      }

      current = current.parentElement;
    }

    return true;
  }

  function getVisibleSpans(card, useComputedStyles = true) {
    const layoutItem = findLayoutItem(card);
    return [...layoutItem.querySelectorAll("span")]
      .filter((element) => isBadgeLayerVisible(element, layoutItem, useComputedStyles));
  }

  function getGridCardCount(grid) {
    const cached = gridCardCounts.get(grid);
    if (cached?.revision === topologyRevision) return cached.count;
    const count = grid.querySelectorAll("div.thumbnail").length;
    gridCardCounts.set(grid, { revision: topologyRevision, count });
    return count;
  }

  function findLayoutItem(card) {
    const grid = card.closest("div.grid");
    if (grid) {
      if ((card.getAttribute("x-show") ?? "").includes("recommendItems")) {
        return card;
      }

      if (grid.children.length > 1 && getGridCardCount(grid) === 1) {
        return grid;
      }

      let item = card;
      while (item.parentElement && item.parentElement !== grid) {
        item = item.parentElement;
      }
      if (item.parentElement === grid) return item;
    }

    const wrapper = card.parentElement;
    if (wrapper && wrapper.children.length === 1) {
      return wrapper;
    }

    return card;
  }

  function hasBlockedStructuredMarker(card) {
    if (!settings.hiddenLabels.includes("uncensored")) return false;
    const itemId = getCardItemId(card, location.href);
    return Boolean(itemId?.endsWith("-uncensored-leak"));
  }

  function shouldHideCard(card, useComputedStyles = true) {
    if (!isFilteringActive()) {
      return false;
    }

    const visibleSpans = getVisibleSpans(card, useComputedStyles);
    const visibleLabels = visibleSpans.filter((label) => isBadge(label) && normalizeText(label.textContent));
    if (hasBlockedStructuredMarker(card)) return true;
    if (visibleLabels.length === 0 && settings.hideUntagged) return true;

    return visibleLabels.some((label) => {
      const condition = label.getAttribute("x-show") ?? label.parentElement?.getAttribute("x-show");
      const kind = LabelLibrary.classifyCondition(condition) ??
        LabelLibrary.classifyText(label.textContent);
      return kind !== null && settings.hiddenLabels.includes(kind);
    });
  }

  function syncCardHiddenState(card) {
    const layoutItem = findLayoutItem(card);
    const hidden =
      layoutItem.classList.contains(LABEL_HIDDEN_CLASS) ||
      layoutItem.classList.contains(CATEGORY_HIDDEN_CLASS) ||
      layoutItem.classList.contains(UNVERIFIED_CLASS) ||
      layoutItem.classList.contains(PENDING_CLASS);
    if (layoutItem.classList.contains(HIDDEN_CLASS) !== hidden) {
      layoutItem.classList.toggle(HIDDEN_CLASS, hidden);
    }
  }

  function setCardHiddenForReason(card, reasonClass, hidden) {
    const layoutItem = findLayoutItem(card);
    layoutItem.classList.toggle(reasonClass, hidden);
    syncCardHiddenState(card);
  }

  function setCardPending(card, pending) {
    setCardHiddenForReason(card, PENDING_CLASS, pending);
  }

  function clearCardFilterState(card) {
    const layoutItem = findLayoutItem(card);
    layoutItem.classList.toggle(LABEL_HIDDEN_CLASS, false);
    layoutItem.classList.toggle(CATEGORY_HIDDEN_CLASS, false);
    layoutItem.classList.toggle(PENDING_CLASS, false);
    layoutItem.classList.toggle(UNVERIFIED_CLASS, false);
    syncCardHiddenState(card);
    cardSettledRevisions.delete(card);
    removeActressNames(card);
  }

  function markCardSettled(card) {
    cardSettledRevisions.set(card, filterRevision);
  }

  function applyVisibleLabelStage(entries, useComputedStyles = true) {
    // Read the site's styles without inheriting our own visibility mask.
    // The entire read is synchronous and the masks are restored in finally
    // before any card writes or yielding, so an unfiltered frame cannot paint.
    const maskedGrids = new Set();
    if (useComputedStyles) {
      for (const { card } of entries) {
        for (let node = card; node; node = node.parentElement) {
          if (node.classList?.contains(SETTLING_GRID_CLASS)) maskedGrids.add(node);
        }
      }
    }
    let decisions;
    try {
      for (const grid of maskedGrids) grid.classList.remove(SETTLING_GRID_CLASS);
      decisions = entries.map((entry) => ({
        entry,
        hidden: shouldHideCard(entry.card, useComputedStyles)
      }));
    } finally {
      for (const grid of maskedGrids) grid.classList.add(SETTLING_GRID_CLASS);
    }

    const survivors = [];
    for (const { entry, hidden } of decisions) {
      setCardHiddenForReason(entry.card, LABEL_HIDDEN_CLASS, hidden);
      if (!hidden) survivors.push(entry);
    }
    return survivors;
  }

  function prepareEntriesForFiltering(entries, useComputedStyles, baseUrl) {
    if (!isFilteringActive()) {
      for (const { card } of entries) clearCardFilterState(card);
      return [];
    }
    const contentEntries = entries.filter((entry) => {
      if (!isHomePlaceholderItem(entry)) return true;
      clearCardFilterState(entry.card);
      return false;
    });
    const visibleEligible = applyVisibleLabelStage(contentEntries, useComputedStyles);
    const survivorCards = new Set(visibleEligible.map(({ card }) => card));

    for (const { card } of contentEntries) {
      if (survivorCards.has(card)) continue;
      removeActressNames(card);
      setCardPending(card, false);
      setCardHiddenForReason(card, UNVERIFIED_CLASS, false);
      setCardHiddenForReason(card, CATEGORY_HIDDEN_CLASS, false);
      markCardSettled(card);
    }

    if (!isFilteringActive() || !needsMetadata()) {
      for (const { card } of visibleEligible) {
        removeActressNames(card);
        setCardPending(card, false);
        setCardHiddenForReason(card, UNVERIFIED_CLASS, false);
        setCardHiddenForReason(card, CATEGORY_HIDDEN_CLASS, false);
        markCardSettled(card);
      }
      return visibleEligible;
    }

    for (const { card } of visibleEligible) {
      const itemId = getCardItemId(card, baseUrl);
      applyCardMetadata(card, itemId);
    }
    metadataClient.request(visibleEligible.map(({ card }) => getCardItemId(card, baseUrl)));

    return visibleEligible;
  }

  function getCardFromGridItem(item) {
    if (item.matches("div.thumbnail")) {
      return item;
    }

    for (const child of item.children) {
      if (child.matches("div.thumbnail")) {
        return child;
      }
    }

    return item.querySelector("div.thumbnail");
  }

  function getGridItems(grid) {
    return [...grid.children]
      .map((item) => ({ item, card: getCardFromGridItem(item) }))
      .filter(({ card }) => Boolean(card));
  }

  function isLoadMoreControl(element) {
    if (!element || element.hidden || element.disabled) return false;
    if (
      element.classList?.contains("hidden") ||
      element.style?.display === "none" ||
      element.style?.visibility === "hidden"
    ) {
      return false;
    }
    const text = normalizeText(element.textContent);
    const action = element.getAttribute?.("@click.prevent") ??
      element.getAttribute?.("x-on:click.prevent") ?? "";
    return /^\s*loadMore\(\s*\d+\s*\)\s*;?\s*$/.test(action) ||
      ["载入更多", "載入更多", "loadmore", "もっと読み込む"].includes(text);
  }

  function comesBefore(left, right) {
    if (!left || !right || left === right) return false;
    if (typeof left.compareDocumentPosition === "function") {
      return Boolean(left.compareDocumentPosition(right) & 4);
    }

    let root = left;
    while (root.parentElement) root = root.parentElement;
    const ordered = [];
    const visit = (element) => {
      ordered.push(element);
      for (const child of element.children ?? []) visit(child);
    };
    visit(root);
    const leftIndex = ordered.indexOf(left);
    const rightIndex = ordered.indexOf(right);
    return leftIndex >= 0 && rightIndex >= 0 && leftIndex < rightIndex;
  }

  function getLoadMoreControls(root = document) {
    return [...new Set([
      ...(root.querySelectorAll?.("button") ?? []),
      ...(root.querySelectorAll?.("a[href]") ?? []),
      ...(root.querySelectorAll?.('[role="button"]') ?? [])
    ])].filter(isLoadMoreControl);
  }

  function findLoadMoreControl(grid) {
    let container = grid?.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1) {
      const grids = [
        ...(container.matches?.("div.grid") ? [container] : []),
        ...(container.querySelectorAll?.("div.grid") ?? [])
      ].filter((candidate) => getGridItems(candidate).length >= 2);
      const controls = [
        ...(["BUTTON", "A"].includes(container.tagName) || container.getAttribute?.("role") === "button"
          ? [container]
          : []),
        ...(container.querySelectorAll?.("button") ?? []),
        ...(container.querySelectorAll?.("a[href]") ?? []),
        ...(container.querySelectorAll?.('[role="button"]') ?? [])
      ];
      const uniqueControls = [...new Set(controls)].filter(isLoadMoreControl);

      if (grids.length === 1 && grids[0] === grid && uniqueControls.length === 1) {
        return uniqueControls[0];
      }

      container = container.parentElement;
    }

    const grids = [...document.querySelectorAll("div.grid")]
      .filter((candidate) => getGridItems(candidate).length >= 2);
    const gridIndex = grids.indexOf(grid);
    if (gridIndex < 0) return null;
    const nextGrid = grids[gridIndex + 1] ?? null;
    return getLoadMoreControls().find((control) =>
      comesBefore(grid, control) && (!nextGrid || comesBefore(control, nextGrid))
    ) ?? null;
  }

  function findPaginatedGrid(root) {
    return [...root.querySelectorAll("div.grid")]
      .find((grid) => getGridItems(grid).length > 0) ?? null;
  }

  function getNextPageUrl(root, baseUrl) {
    const href = root.querySelector('a[rel="next"][href]')?.getAttribute("href");
    if (!href) return null;

    try {
      const target = new URL(href, baseUrl);
      return target.origin === new URL(baseUrl).origin ? target.href : null;
    } catch {
      return null;
    }
  }

  function getCardKey(card, baseUrl) {
    const href = card.querySelector("a[href]")?.getAttribute("href");
    if (!href) return null;

    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      return url.href;
    } catch {
      return href;
    }
  }

  function getCardItemId(card, baseUrl) {
    const key = getCardKey(card, baseUrl);
    if (!key) return null;

    try {
      const segments = new URL(key).pathname.split("/").filter(Boolean);
      return segments.at(-1)?.toLocaleLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  function categoryFilteringEnabled() {
    return site.metadata === "missav" && (
      settings.categoryIncludeRules.length > 0 ||
      settings.categoryExcludeRules.length > 0
    );
  }

  function metadataFilteringEnabled() {
    return categoryFilteringEnabled() || (site.metadata === "missav" && settings.actressLimitEnabled);
  }

  function needsMetadata() {
    return metadataFilteringEnabled() || (site.metadata === "missav" && settings.showActressNames);
  }

  function removeActressNames(card) {
    card.querySelector(`.${ACTRESS_NAMES_CLASS}`)?.remove();
    card.classList.remove(ACTRESS_HOST_CLASS);
  }

  function updateActressNames(card, metadata) {
    const names = metadata?.cast?.names;
    if (!isFilteringActive() || site.metadata !== "missav" || !settings.showActressNames ||
        !Array.isArray(names) || names.length === 0) {
      removeActressNames(card);
      return;
    }
    let overlay = card.querySelector(`.${ACTRESS_NAMES_CLASS}`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = ACTRESS_NAMES_CLASS;
      card.append(overlay);
    }
    card.classList.add(ACTRESS_HOST_CLASS);
    const text = names.slice(0, 3).join("、") + (names.length > 3 ? "…" : "");
    // Reading the badge's style forces layout, so size the overlay only when its text changes.
    if (overlay.textContent === text) return;
    overlay.textContent = text;
    const badge = [...card.querySelectorAll("span")].find(isBadge);
    const badgeSize = badge ? Number.parseFloat(getComputedStyle(badge).fontSize) : 12;
    const fontSize = `${Math.max(24, (Number.isFinite(badgeSize) ? badgeSize : 12) * 2)}px`;
    if (overlay.style.fontSize !== fontSize) overlay.style.fontSize = fontSize;
  }

  function metadataValues(metadata) {
    if (!metadata) return [];
    return [
      ...(Array.isArray(metadata.genres) ? metadata.genres : []),
      ...(Array.isArray(metadata.tags) ? metadata.tags : []),
      ...(metadata.type ? [metadata.type] : [])
    ];
  }

  function metadataPassesFilters(metadata) {
    if (!metadata) return false;

    if (settings.actressLimitEnabled &&
        Number.isSafeInteger(metadata.cast?.confirmedCount) &&
        metadata.cast.confirmedCount > settings.maxActresses) return false;

    const values = metadataValues(metadata);
    const excluded = settings.categoryExcludeRules.some((rule) =>
      CategoryLibrary.matches(rule, values, metadata)
    );
    if (excluded) return false;

    return (
      settings.categoryIncludeRules.length === 0 ||
      settings.categoryIncludeRules.some((rule) =>
        CategoryLibrary.matches(rule, values, metadata)
      )
    );
  }

  function sendMetadataQuery(itemIds) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "viewing-assistant-query-metadata", itemIds },
        (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            resolve({});
            return;
          }
          resolve(response.items ?? {});
        }
      );
    });
  }

  function metadataDecision(itemId) {
    if (!metadataFilteringEnabled()) return "passed";
    if (!itemId) return "unverified";
    const record = metadataClient.get(itemId);
    if (["idle", "pending"].includes(record.status)) return "pending";
    // The service has no record of this video, so retrying cannot help. It can
    // only fail a "show only" rule; hide and exclude rules have nothing to match.
    if (record.status === "missing") return settings.categoryIncludeRules.length > 0 && categoryFilteringEnabled() ? "blocked" : "passed";
    if (record.status !== "ready") return "unverified";
    const metadata = record.data;
    if (categoryFilteringEnabled() && (!Array.isArray(metadata.genres) || !Array.isArray(metadata.tags) ||
        typeof metadata.type !== "string")) {
      return "unverified";
    }
    if (settings.actressLimitEnabled && !Array.isArray(metadata.actresses)) return "unverified";
    if ([...settings.categoryIncludeRules, ...settings.categoryExcludeRules].includes("group:duration-4h-plus") &&
        (metadata.duration === null || metadata.duration === undefined || !Number.isFinite(Number(metadata.duration)))) {
      return "unverified";
    }
    return metadataPassesFilters(metadata) ? "passed" : "blocked";
  }

  function applyCardMetadata(card, itemId) {
    const decision = metadataDecision(itemId);
    const layoutItem = findLayoutItem(card);
    // Apply a single decision before syncing visibility: no intermediate reveal.
    layoutItem.classList.toggle(CATEGORY_HIDDEN_CLASS, decision === "blocked");
    layoutItem.classList.toggle(PENDING_CLASS, decision === "pending");
    layoutItem.classList.toggle(UNVERIFIED_CLASS, decision === "unverified");
    syncCardHiddenState(card);
    if (decision === "pending") cardSettledRevisions.delete(card);
    else markCardSettled(card);
    // Display is a projection of available data, independent of request lifetime.
    updateActressNames(card, metadataClient.get(itemId).data);
    return decision;
  }

  function retryMetadata(ids = null) {
    if (ids) metadataClient.retry(ids);
    else metadataClient.invalidateUnresolved();
    paginationNeedsRetry = false;
    paginationRunKey = null;
    infiniteNeedsRetry = false;
    stalledPageIds.clear();
    scheduleScan();
    if (settings.infiniteScroll && infiniteGrid) void loadNextInfiniteBatch(filterRevision);
  }

  function updateMetadataNotices() {
    const activeGrids = new Set();
    if (isFilteringActive() && (needsMetadata() || paginationNeedsRetry || paginationResumeUrl)) {
      const paginatedGrid = findPaginatedGrid(document);
      for (const grid of document.querySelectorAll("div.grid")) {
        const unresolved = new Set();
        for (const entry of getGridItems(grid)) {
          if (isHomePlaceholderItem(entry)) continue;
          const { card } = entry;
          if (findLayoutItem(card).classList.contains(LABEL_HIDDEN_CLASS)) continue;
          const id = getCardItemId(card, location.href);
          const record = metadataClient.get(id);
          if (metadataDecision(id) === "unverified" ||
              (!metadataFilteringEnabled() && (record.status === "error" ||
                (record.status === "ready" && !Array.isArray(record.data.actresses))))) unresolved.add(id);
        }
        if (grid === paginatedGrid) {
          for (const id of stalledPageIds) unresolved.add(id);
        }
        const pageFailed = paginationNeedsRetry && grid === paginatedGrid;
        const pageLimit = Boolean(paginationResumeUrl) && grid === paginatedGrid;
        if (unresolved.size === 0 && !pageFailed && !pageLimit) continue;
        activeGrids.add(grid);
        let notice = metadataNotices.get(grid);
        if (!notice) {
          notice = document.createElement("button");
          notice.type = "button";
          notice.className = "viewing-assistant-retry";
          grid.after(notice);
          metadataNotices.set(grid, notice);
        }
        const limitOnly = unresolved.size === 0 && !pageFailed;
        const text = limitOnly ? `已往后查找 ${MAX_REFILL_PAGES} 页，符合规则的影片仍不够一页。点击继续查找，或在设置中放宽规则`
          : unresolved.size === 0 ? "下一页未能加载。点击重试" : metadataFilteringEnabled()
            ? `${unresolved.size} 部影片资料未能确认，暂未显示。点击重试`
            : `${unresolved.size} 部影片姓名未能加载。点击重试`;
        if (notice.textContent !== text) notice.textContent = text;
        notice.onclick = limitOnly ? continuePagination : () => retryMetadata([...unresolved]);
      }
    }
    for (const [grid, notice] of metadataNotices) {
      if (activeGrids.has(grid)) continue;
      notice.remove();
      metadataNotices.delete(grid);
    }
  }

  async function processPageEntries(entries, baseUrl, revision, onPassed) {
    const visibleEligible = applyVisibleLabelStage(entries, false);
    const withIds = visibleEligible.map((entry) => ({
      ...entry,
      itemId: getCardItemId(entry.card, baseUrl)
    }));
    const delivered = new Set();
    const deliver = () => {
      if (revision !== filterRevision || !isFilteringActive()) return;
      for (const entry of withIds) {
        if (delivered.has(entry) || metadataDecision(entry.itemId) !== "passed") continue;
        delivered.add(entry);
        onPassed(entry);
      }
    };
    const ids = withIds.map(({ itemId }) => itemId).filter(Boolean);
    if (needsMetadata()) metadataClient.request(ids);
    deliver();
    // Names-only display does not hold up page insertion or pagination.
    if (metadataFilteringEnabled()) {
      const unsubscribe = metadataClient.subscribe(deliver);
      try { await metadataClient.settled(ids); }
      finally { unsubscribe(); }
      deliver();
    }
    if (revision !== filterRevision || !isFilteringActive()) return { cancelled: true, unresolved: [] };
    const unresolved = withIds.filter(({ itemId }) => metadataDecision(itemId) === "unverified");
    return { cancelled: false, unresolved: unresolved.map(({ itemId }) => itemId) };
  }

  function requestFullScan() {
    fullScanPending = true;
    scheduleScan();
  }

  // Work started for one list must not reach another list the site shows in
  // the same document.
  function forgetListWork() {
    cancelPageRequests();
    paginationRunKey = null;
    paginationResumeUrl = null;
    paginationNeedsRetry = false;
    paginationTask = null;
    stalledPageIds.clear();
    filterRevision += 1;
    topologyRevision += 1;
  }

  function filterCurrentDocument() {
    let cards = [...document.querySelectorAll("div.thumbnail")];
    const listUrl = location.href.split("#")[0];
    if (lastScannedUrl !== null && lastScannedUrl !== listUrl) {
      forgetListWork();
      teardownInfiniteScroll();
      removeRefillItems();
      cards = [...document.querySelectorAll("div.thumbnail")];
    }
    if (fullScanPending || lastScannedUrl !== listUrl) {
      fullScanPending = false;
      lastScannedUrl = listUrl;
      changedMetadataIds.clear();
    } else {
      const ids = new Set(changedMetadataIds);
      changedMetadataIds.clear();
      cards = ids.size === 0 ? [] : cards.filter((card) => ids.has(getCardItemId(card, location.href)));
    }
    if (cards.length > 0) {
      prepareEntriesForFiltering(cards.map((card) => ({ item: findLayoutItem(card), card })), true, location.href);
    }
    updateMetadataNotices();
  }

  function activateImportedImages(root) {
    for (const image of root.querySelectorAll("img")) {
      const lazySource = image.getAttribute("data-src");
      const lazySourceSet = image.getAttribute("data-srcset");

      if (lazySource) image.setAttribute("src", lazySource);
      if (lazySourceSet) image.setAttribute("srcset", lazySourceSet);
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
    }
  }

  function isHiddenGridItem({ card }) {
    return findLayoutItem(card).classList.contains(HIDDEN_CLASS);
  }

  function isHomePlaceholderItem({ item, card }) {
    const showExpression = [item, card]
      .map((element) => element.getAttribute?.("x-show") ?? "")
      .join(" ");
    return showExpression.includes("recommendItems");
  }

  function getHomeContentEntries(grid) {
    return getGridItems(grid)
      .filter((entry) => !isHomePlaceholderItem(entry));
  }

  function getVisibleHomeGridCount(grid) {
    return getHomeContentEntries(grid)
      .filter((entry) => !isHiddenGridItem(entry))
      .length;
  }

  function isHomeGridSettled(grid) {
    return getHomeContentEntries(grid)
      .every(({ card }) => cardSettledRevisions.get(card) === filterRevision);
  }

  function releaseHomeGrid(grid) {
    if (!homeGridPending.has(grid)) return false;
    homeGridPending.delete(grid);
    homeGridRequestTokens.delete(grid);
    activeHomeRefills = Math.max(0, activeHomeRefills - 1);
    return true;
  }

  function setHomeGridSettling(grid, control, settling) {
    const previousControl = homeGridControls.get(grid);
    if (previousControl && previousControl !== control) {
      previousControl.classList.toggle(BUSY_CONTROL_CLASS, false);
    }

    grid.classList.toggle(SETTLING_GRID_CLASS, settling);
    if (control) {
      control.classList.toggle(BUSY_CONTROL_CLASS, settling);
      if (settling) homeGridControls.set(grid, control);
    }

    if (!settling) {
      previousControl?.classList.toggle(BUSY_CONTROL_CLASS, false);
      homeGridControls.delete(grid);
      homeGridRevealTimers.delete(grid);
    }
  }

  function noteHomeGridActivity(cards) {
    const grids = new Set(cards.map((card) => card.closest("div.grid")).filter(Boolean));
    for (const grid of grids) {
      homeGridActivityVersions.set(
        grid,
        (homeGridActivityVersions.get(grid) ?? 0) + 1
      );
    }
  }

  function scheduleHomeGridReveal(grid, control) {
    if (homeGridRevealTimers.has(grid)) return;

    const activityVersion = homeGridActivityVersions.get(grid) ?? 0;
    const timerToken = {};
    homeGridRevealTimers.set(grid, timerToken);
    setTimeout(() => {
      if (homeGridRevealTimers.get(grid) !== timerToken) return;
      homeGridRevealTimers.delete(grid);

      if ((homeGridActivityVersions.get(grid) ?? 0) !== activityVersion) {
        scheduleScan();
        return;
      }

      prepareEntriesForFiltering(
        getHomeContentEntries(grid),
        true,
        location.href
      );

      const currentControl = findLoadMoreControl(grid);
      const attempts = homeGridAttempts.get(grid) ?? 0;
      const dataUnsettled = getHomeContentEntries(grid).some(({ card }) => {
        const item = findLayoutItem(card);
        return item.classList.contains(PENDING_CLASS) || item.classList.contains(UNVERIFIED_CLASS);
      });
      const terminal =
        getVisibleHomeGridCount(grid) >= MIN_HOME_VISIBLE_ITEMS ||
        !currentControl ||
        attempts >= MAX_HOME_REFILL_CLICKS || dataUnsettled;
      if (
        !homeGridPending.has(grid) &&
        (isHomeGridSettled(grid) || dataUnsettled) &&
        terminal
      ) {
        setHomeGridSettling(grid, currentControl ?? control, false);
      } else {
        scheduleScan();
      }
    }, HOME_GRID_REVEAL_QUIET_MS);
  }

  function refillHomeGrids() {
    for (const grid of document.querySelectorAll("div.grid")) {
      const control = findLoadMoreControl(grid);
      const visibleCount = getVisibleHomeGridCount(grid);
      const fullyProcessed = isHomeGridSettled(grid);
      const attempts = homeGridAttempts.get(grid) ?? 0;

      if (!isFilteringActive()) {
        if (!homeGridPending.has(grid)) {
          setHomeGridSettling(grid, control, false);
        }
        continue;
      }

      if (!fullyProcessed) {
        const waitingForData = getHomeContentEntries(grid).some(({ card }) =>
          findLayoutItem(card).classList.contains(PENDING_CLASS));
        if (waitingForData) {
          // Keep an existing native-label settling window, but release it on
          // its own timer even if metadata is still pending. Other grids proceed.
          if (grid.classList.contains(SETTLING_GRID_CLASS)) scheduleHomeGridReveal(grid, control);
        } else if (control || grid.classList.contains(SETTLING_GRID_CLASS)) {
          setHomeGridSettling(grid, control, true);
        }
        continue;
      }

      if (getHomeContentEntries(grid).some(({ card }) => findLayoutItem(card).classList.contains(UNVERIFIED_CLASS))) {
        if (grid.classList.contains(SETTLING_GRID_CLASS)) scheduleHomeGridReveal(grid, control);
        continue;
      }

      if (
        visibleCount >= MIN_HOME_VISIBLE_ITEMS ||
        !control ||
        attempts >= MAX_HOME_REFILL_CLICKS
      ) {
        if (!homeGridPending.has(grid)) {
          if (grid.classList.contains(SETTLING_GRID_CLASS)) {
            scheduleHomeGridReveal(grid, control);
          } else {
            setHomeGridSettling(grid, control, false);
          }
        }
        continue;
      }

      setHomeGridSettling(grid, control, true);
      if (
        homeGridPending.has(grid) ||
        activeHomeRefills >= MAX_CONCURRENT_HOME_REFILLS
      ) {
        continue;
      }

      homeGridPending.add(grid);
      const requestToken = {};
      homeGridRequestTokens.set(grid, requestToken);
      homeGridAttempts.set(grid, attempts + 1);
      activeHomeRefills += 1;

      setTimeout(() => {
        if (homeGridRequestTokens.get(grid) !== requestToken) return;
        if (!isFilteringActive() || grid.isConnected === false || !isLoadMoreControl(control)) {
          releaseHomeGrid(grid);
          scheduleScan();
          return;
        }

        const itemCountBeforeClick = getGridItems(grid).length;
        control.click();

        setTimeout(() => {
          if (homeGridRequestTokens.get(grid) !== requestToken) return;
          const clickWasAcknowledged =
            getGridItems(grid).length > itemCountBeforeClick ||
            !isLoadMoreControl(control);
          if (clickWasAcknowledged) return;

          releaseHomeGrid(grid);
          scheduleScan();
        }, HOME_REFILL_ACK_TIMEOUT_MS);

        setTimeout(() => {
          if (homeGridRequestTokens.get(grid) !== requestToken || !releaseHomeGrid(grid)) return;
          scheduleScan();
        }, HOME_REFILL_RESPONSE_TIMEOUT_MS);
      }, 0);
    }
  }

  function recordHomeGridAdditions(mutations) {
    const additionsByGrid = new Map();
    for (const mutation of mutations) {
      const grid = mutation?.type === "childList" && mutation.target?.matches?.("div.grid")
        ? mutation.target
        : null;
      if (!grid) continue;
      const addedItems = [...(mutation.addedNodes ?? [])]
        .filter((node) => node?.nodeType === 1 && getCardFromGridItem(node));
      if (addedItems.length === 0) continue;
      const stored = additionsByGrid.get(grid) ?? [];
      stored.push(...addedItems);
      additionsByGrid.set(grid, stored);
    }

    for (const [grid, addedItems] of additionsByGrid) {
      if (homeGridPending.has(grid)) {
        releaseHomeGrid(grid);
      } else {
        homeGridAttempts.set(grid, 0);
      }
    }
  }

  function appendImportedItem(grid, item, baseUrl) {
    const importedItem = document.importNode(item, true);
    importedItem.setAttribute(REFILL_ATTRIBUTE, "true");
    activateImportedImages(importedItem);
    const importedCard = getCardFromGridItem(importedItem);
    // Reset the clone before committing its final state, never after rendering.
    clearCardFilterState(importedCard);
    grid.append(importedItem);
    topologyRevision += 1;
    // The source page was parsed without styles; now the page's own CSS can
    // hide a badge, so judge the labels again before counting the card.
    const visible = applyVisibleLabelStage([{ item: findLayoutItem(importedCard), card: importedCard }], true).length > 0;
    applyCardMetadata(importedCard, getCardItemId(importedCard, baseUrl));
    return visible;
  }

  function resolveImportedUrl(value, baseUrl, requiredOrigin = null) {
    try {
      const url = new URL(value, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      if (requiredOrigin && url.origin !== requiredOrigin) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function resolveSourceSet(value, baseUrl) {
    // Candidates are "url [descriptor]" separated by commas; a URL may itself
    // contain commas, so split on the comma that follows a descriptor.
    const candidates = [];
    let rest = String(value);
    while (rest) {
      rest = rest.replace(/^[\s,]+/, "");
      if (!rest) break;
      let url = /^\S+/.exec(rest)[0];
      rest = rest.slice(url.length);
      let descriptor = "";
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
      } else {
        const separator = rest.indexOf(",");
        descriptor = (separator < 0 ? rest : rest.slice(0, separator)).trim();
        rest = separator < 0 ? "" : rest.slice(separator + 1);
      }
      const resolved = resolveImportedUrl(url, baseUrl);
      const validDescriptor = !descriptor || /^[1-9]\d*w$/.test(descriptor) ||
        (/^(?:\d+(?:\.\d+)?|\.\d+)x$/.test(descriptor) && Number.parseFloat(descriptor) > 0);
      if (resolved && validDescriptor) candidates.push(resolved + (descriptor ? ` ${descriptor}` : ""));
    }
    return candidates.join(", ");
  }

  // Imported cards are moved into this page, so relative links would otherwise
  // resolve against the wrong directory. Links stay on the same site.
  // Everything resolves against the source document's base, as the browser
  // would; links must stay on the source page's site, media may not.
  function normalizeImportedUrls(root, baseUrl, pageOrigin) {
    for (const node of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of ["href", "src", "data-src", "poster"]) {
        if (!node.hasAttribute(attribute)) continue;
        const value = resolveImportedUrl(node.getAttribute(attribute), baseUrl, attribute === "href" ? pageOrigin : null);
        if (value) node.setAttribute(attribute, value);
        else node.removeAttribute(attribute);
      }
      for (const attribute of ["srcset", "data-srcset"]) {
        if (!node.hasAttribute(attribute)) continue;
        const value = resolveSourceSet(node.getAttribute(attribute), baseUrl);
        if (value) node.setAttribute(attribute, value);
        else node.removeAttribute(attribute);
      }
    }
  }

  function cancelPageRequests() {
    for (const controller of pageRequests) controller.abort();
    pageRequests.clear();
  }

  function rememberPage(url, page) {
    pageHtmlCache.delete(url);
    pageHtmlCache.set(url, page);
    while (pageHtmlCache.size > MAX_CACHED_PAGES) {
      pageHtmlCache.delete(pageHtmlCache.keys().next().value);
    }
  }

  async function downloadPage(url) {
    const controller = new AbortController();
    pageRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), PAGE_REQUEST_TIMEOUT_MS);
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    try {
      // The deadline covers both the response headers and the body.
      const response = await Promise.race([
        fetch(url, { credentials: "same-origin", signal: controller.signal }), aborted
      ]);
      if (!response.ok) return null;
      const sourceUrl = resolveImportedUrl(response.url || url, url, new URL(url, location.href).origin);
      if (!sourceUrl) return null;
      const html = await Promise.race([response.text(), aborted]);
      return { html, sourceUrl };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      pageRequests.delete(controller);
    }
  }

  // Returns the parsed page and the URL its relative links resolve against.
  async function fetchPageDocument(url) {
    const revision = filterRevision;
    const page = pageHtmlCache.get(url) ?? await downloadPage(url);
    if (!page || revision !== filterRevision) return null;

    const parsed = new DOMParser().parseFromString(page.html, "text/html");
    const grid = findPaginatedGrid(parsed);
    if (!SiteLibrary.inspect(parsed, page.sourceUrl).compatible || !grid) return null;
    const baseHref = parsed.querySelector("base[href]")?.getAttribute("href");
    const pageOrigin = new URL(page.sourceUrl).origin;
    const documentBase = (baseHref && resolveImportedUrl(baseHref, page.sourceUrl)) || page.sourceUrl;
    const baseUrl = (baseHref && resolveImportedUrl(baseHref, page.sourceUrl, pageOrigin)) || page.sourceUrl;
    for (const { item } of getGridItems(grid)) normalizeImportedUrls(item, documentBase, pageOrigin);
    rememberPage(url, page);
    return { document: parsed, grid, baseUrl };
  }

  async function refillPaginatedGrid(revision) {
    if (!isFilteringActive() || revision !== filterRevision) return;

    const basePageUrl = location.href;
    let nextPageUrl = paginationResumeUrl ?? getNextPageUrl(document, basePageUrl);
    paginationResumeUrl = null;
    if (!nextPageUrl) return;

    const grid = findPaginatedGrid(document);
    if (!grid) return;

    const nativeItems = getGridItems(grid)
      .filter(({ item }) => !item.hasAttribute(REFILL_ATTRIBUTE));
    const targetSize = nativeItems.length;
    let visibleCount = getGridItems(grid).filter((entry) => !isHiddenGridItem(entry)).length;

    if (targetSize === 0 || visibleCount >= targetSize) return;

    const seenCardKeys = new Set(
      getGridItems(grid)
        .map(({ card }) => getCardKey(card, basePageUrl))
        .filter(Boolean)
    );
    const visitedPages = new Set();

    while (
      nextPageUrl &&
      visibleCount < targetSize &&
      visitedPages.size < MAX_REFILL_PAGES
    ) {
      if (
        revision !== filterRevision ||
        location.href !== basePageUrl ||
        visitedPages.has(nextPageUrl)
      ) {
        return;
      }

      visitedPages.add(nextPageUrl);
      const page = await fetchPageDocument(nextPageUrl);
      if (revision !== filterRevision || location.href !== basePageUrl) return;
      // A retry continues from the page that failed, not from the first page.
      if (!page) { paginationResumeUrl = nextPageUrl; paginationNeedsRetry = true; return; }

      const result = await processPageEntries(
        getGridItems(page.grid),
        page.baseUrl,
        revision,
        ({ item, card }) => {
          if (visibleCount >= targetSize) return;
          const cardKey = getCardKey(card, page.baseUrl);
          if (cardKey && seenCardKeys.has(cardKey)) return;
          if (cardKey) seenCardKeys.add(cardKey);
          if (appendImportedItem(grid, item, page.baseUrl)) visibleCount += 1;
        }
      );
      if (result.cancelled) return;
      if (result.unresolved.length > 0 && visibleCount < targetSize) {
        for (const id of result.unresolved) stalledPageIds.add(id);
        paginationResumeUrl = nextPageUrl;
        paginationNeedsRetry = true;
        return;
      }

      nextPageUrl = getNextPageUrl(page.document, page.baseUrl);
    }
    if (nextPageUrl && visibleCount < targetSize) {
      paginationResumeUrl = nextPageUrl;
      updateMetadataNotices();
    }
  }

  function continuePagination() {
    paginationRunKey = null;
    scheduleScan();
  }

  function startPaginatedRefill(revision) {
    if (paginationNeedsRetry || paginationTask?.revision === revision) return;
    // Stopped at the page limit: wait until the reader asks to continue.
    if (paginationResumeUrl && paginationRunKey !== null) return;
    const grid = findPaginatedGrid(document);
    if (!grid || !getNextPageUrl(document, location.href)) return;
    const native = getGridItems(grid).filter(({ item }) => !item.hasAttribute(REFILL_ATTRIBUTE));
    if (native.some(({ card }) => {
      const item = findLayoutItem(card);
      return item.classList.contains(PENDING_CLASS) || item.classList.contains(UNVERIFIED_CLASS);
    })) return;
    const key = `${revision}:${native.length}:${native.filter((entry) => !isHiddenGridItem(entry)).length}`;
    if (paginationRunKey === key) return;
    paginationRunKey = key;
    const task = { revision };
    paginationTask = task;
    void refillPaginatedGrid(revision).finally(() => {
      if (paginationTask !== task) return;
      paginationTask = null;
      scheduleScan();
    });
  }

  function setInfiniteStatus(message, state = "idle") {
    if (!infiniteSentinel) return;
    infiniteSentinel.textContent = message;
    infiniteSentinel.classList.toggle("is-loading", state === "loading");
    infiniteSentinel.classList.toggle("is-complete", state === "complete");
    infiniteSentinel.classList.toggle("is-error", state === "error");
  }

  async function loadNextInfiniteBatch(revision) {
    if (
      infiniteLoading ||
      infiniteNeedsRetry ||
      !infiniteGrid ||
      !infiniteNextPageUrl ||
      revision !== filterRevision ||
      !isFilteringActive() ||
      !settings.infiniteScroll
    ) {
      return;
    }

    infiniteLoading = true;
    const loadToken = {};
    infiniteLoadToken = loadToken;
    setInfiniteStatus("正在筛选下一页…", "loading");
    let appendedCount = 0;
    let checkedPages = 0;

    try {
      while (
        infiniteNextPageUrl &&
        appendedCount === 0 &&
        checkedPages < MAX_REFILL_PAGES
      ) {
        if (revision !== filterRevision || !settings.infiniteScroll) return;

        const pageUrl = infiniteNextPageUrl;
        const page = await fetchPageDocument(pageUrl);
        if (revision !== filterRevision || infiniteLoadToken !== loadToken) return;
        if (!page) {
          setInfiniteStatus("加载失败，点击这里重试", "error");
          infiniteNeedsRetry = true;
          return;
        }

        checkedPages += 1;
        const nextPageUrl = getNextPageUrl(page.document, page.baseUrl);
        const result = await processPageEntries(
          getGridItems(page.grid),
          page.baseUrl,
          revision,
          ({ item, card }) => {
            const cardKey = getCardKey(card, page.baseUrl);
            if (cardKey && infiniteSeenCardKeys.has(cardKey)) return;
            if (cardKey) infiniteSeenCardKeys.add(cardKey);
            if (appendImportedItem(infiniteGrid, item, page.baseUrl)) appendedCount += 1;
          }
        );
        if (result.cancelled) return;
        if (result.unresolved.length > 0) {
          for (const id of result.unresolved) stalledPageIds.add(id);
          infiniteNeedsRetry = true;
          setInfiniteStatus("部分影片资料未能确认，点击重试", "error");
          updateMetadataNotices();
          return;
        }
        // Commit the cursor only after the page's decisions have settled.
        infiniteNextPageUrl = nextPageUrl;
      }

      if (!infiniteNextPageUrl) {
        setInfiniteStatus("已经到底了", "complete");
        infiniteObserver?.disconnect();
      } else if (appendedCount === 0) {
        setInfiniteStatus(`连续 ${MAX_REFILL_PAGES} 页没有符合规则的影片。点击继续查找，或在设置中放宽规则`, "error");
      } else {
        setInfiniteStatus("继续向下滚动", "idle");
        infiniteObserver?.unobserve(infiniteSentinel);
        infiniteObserver?.observe(infiniteSentinel);
      }
    } finally {
      if (infiniteLoadToken === loadToken) infiniteLoading = false;
    }
  }

  function teardownInfiniteScroll() {
    infiniteObserver?.disconnect();
    infiniteSentinel?.remove();
    infiniteObserver = null;
    infiniteSentinel = null;
    infiniteGrid = null;
    infiniteNextPageUrl = null;
    infiniteLoading = false;
    infiniteLoadToken = null;
    infiniteNeedsRetry = false;
    infiniteSeenCardKeys = new Set();
  }

  function setupInfiniteScroll(revision) {
    if (infiniteObserver || !isFilteringActive() || !settings.infiniteScroll) return;

    const basePageUrl = location.href;
    const nextPageUrl = getNextPageUrl(document, basePageUrl);
    const grid = findPaginatedGrid(document);
    if (!nextPageUrl || !grid) return;

    infiniteGrid = grid;
    infiniteNextPageUrl = nextPageUrl;
    infiniteSeenCardKeys = new Set(
      getGridItems(grid)
        .map(({ card }) => getCardKey(card, basePageUrl))
        .filter(Boolean)
    );

    infiniteSentinel = document.createElement("button");
    infiniteSentinel.type = "button";
    infiniteSentinel.className = "viewing-assistant-sentinel";
    infiniteSentinel.textContent = "继续向下滚动";
    infiniteSentinel.addEventListener("click", () => {
      if (infiniteNeedsRetry) retryMetadata([...stalledPageIds]);
      else void loadNextInfiniteBatch(filterRevision);
    });
    grid.after(infiniteSentinel);

    infiniteObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadNextInfiniteBatch(revision);
      }
    }, { rootMargin: "600px 0px" });
    infiniteObserver.observe(infiniteSentinel);
  }

  function removeRefillItems() {
    topologyRevision += 1;
    for (const item of document.querySelectorAll(`[${REFILL_ATTRIBUTE}]`)) {
      item.remove();
    }
  }

  function restoreUnfilteredPage() {
    cancelPageRequests();
    teardownInfiniteScroll();
    removeRefillItems();
    for (const grid of document.querySelectorAll("div.grid")) {
      releaseHomeGrid(grid);
      homeGridAttempts.delete(grid);
      setHomeGridSettling(grid, homeGridControls.get(grid), false);
    }
    for (const card of document.querySelectorAll("div.thumbnail")) {
      clearCardFilterState(card);
    }
    updateMetadataNotices();
  }

  function runWorkLoop() {
    if (workLoopRunning) return;

    workLoopRunning = true;
    try {
      while (workRequested) {
        workRequested = false;
        if (!isFilteringActive()) {
          restoreUnfilteredPage();
          continue;
        }
        const revision = filterRevision;
        filterCurrentDocument();
        if (revision !== filterRevision) continue;
        refillHomeGrids();
        if (isFilteringActive() && settings.infiniteScroll) {
          setupInfiniteScroll(revision);
        } else {
          teardownInfiniteScroll();
          startPaginatedRefill(revision);
        }
      }
    } finally {
      workLoopRunning = false;
      if (workRequested) scheduleScan();
    }
  }

  function scheduleScan() {
    workRequested = true;
    if (scanScheduled || workLoopRunning) return;

    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      void runWorkLoop();
    });
  }

  function isInsideRefillItem(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(element?.closest?.(`[${REFILL_ATTRIBUTE}]`));
  }

  function nodeContainsUnprocessedCard(node) {
    if (node?.nodeType !== 1 || isInsideRefillItem(node)) return false;
    return (
      node.matches?.("div.thumbnail") ||
      Boolean(node.querySelector?.("div.thumbnail"))
    );
  }

  function mutationTargetBelongsToVideoItem(target) {
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    const grid = element?.closest?.("div.grid");
    if (!element || !grid || element === grid) return false;

    if (grid.children.length > 1 && getGridCardCount(grid) === 1) return true;

    let item = element;
    while (item.parentElement && item.parentElement !== grid) {
      item = item.parentElement;
    }
    if (item.parentElement !== grid) return false;
    return (
      item.matches?.("div.thumbnail") ||
      Boolean(item.querySelector?.("div.thumbnail"))
    );
  }

  function mutationAffectsVideoCards(mutation) {
    const belongsToNames = (node) => {
      const element = node?.nodeType === 1 ? node : node?.parentElement;
      return Boolean(element?.closest?.(`.${ACTRESS_NAMES_CLASS}`));
    };
    if (belongsToNames(mutation?.target)) return false;
    const changedNodes = [...(mutation?.addedNodes ?? []), ...(mutation?.removedNodes ?? [])];
    if (mutation?.type === "childList" && changedNodes.length && changedNodes.every(belongsToNames)) return false;
    if (isInsideRefillItem(mutation?.target)) {
      return false;
    }

    if (mutation?.type === "attributes") {
      if (!OBSERVED_ATTRIBUTES.includes(mutation.attributeName)) return false;
      const target = mutation.target?.nodeType === 1
        ? mutation.target
        : mutation.target?.parentElement;
      if (!target) return false;
      // A reused card keeps its node and only swaps the link.
      if (mutation.attributeName === "href") return Boolean(target.closest?.("div.thumbnail"));
      let wasBadge = false;
      if (mutation.attributeName === "class") {
        const siteClasses = (value) => String(value ?? "").split(/\s+/)
          .filter((name) => name && !OWN_CLASSES.has(name)).sort().join(" ");
        if (siteClasses(mutation.oldValue) === siteClasses(target.getAttribute("class"))) return false;
        // A span that just lost its badge classes still changes the labels.
        const old = new Set(String(mutation.oldValue ?? "").split(/\s+/));
        wasBadge = target.matches?.("span") && (old.has("badge") || (old.has("bottom-1") && old.has("left-1")));
      }
      const possibleBadges = [
        ...(target.matches?.("span") ? [target] : []),
        ...(target.querySelectorAll?.("span") ?? [])
      ];
      return (wasBadge || possibleBadges.some(isBadge)) && (
        Boolean(target.closest?.("div.thumbnail")) ||
        mutationTargetBelongsToVideoItem(target)
      );
    }

    if (mutation?.type !== "childList") return false;

    if (
      mutation.target?.closest?.("div.thumbnail") ||
      mutationTargetBelongsToVideoItem(mutation.target)
    ) {
      return true;
    }
    return [...(mutation.addedNodes ?? []), ...(mutation.removedNodes ?? [])]
      .some(nodeContainsUnprocessedCard);
  }

  function collectMutationCards(mutations) {
    const cards = new Set();
    const addCardsFromNode = (node) => {
      if (node?.nodeType !== 1 || isInsideRefillItem(node)) return;
      if (node.matches?.("div.thumbnail")) cards.add(node);
      for (const card of node.querySelectorAll?.("div.thumbnail") ?? []) {
        cards.add(card);
      }
    };

    for (const mutation of mutations) {
      const target = mutation.target?.nodeType === 1
        ? mutation.target
        : mutation.target?.parentElement;
      const closestCard = target?.closest?.("div.thumbnail");
      if (closestCard) cards.add(closestCard);

      if (!closestCard && mutationTargetBelongsToVideoItem(target)) {
        const grid = target.closest("div.grid");
        // A grid holding a single card is that card's layout item, so a badge
        // in any of its branches belongs to the card.
        if (grid.children.length > 1 && getGridCardCount(grid) === 1) {
          const card = grid.querySelector("div.thumbnail");
          if (card) cards.add(card);
        } else {
          let item = target;
          while (item.parentElement && item.parentElement !== grid) {
            item = item.parentElement;
          }
          const card = item.parentElement === grid ? getCardFromGridItem(item) : null;
          if (card) cards.add(card);
        }
      }

      if (mutation.type === "attributes" && !closestCard) addCardsFromNode(target);
      // Adding or removing items can change which element holds each card.
      if (mutation.type === "childList" && !closestCard) addCardsFromNode(target?.closest?.("div.grid"));
      for (const node of mutation.addedNodes ?? []) addCardsFromNode(node);
    }

    return [...cards];
  }

  function startObserver() {
    if (observerStarted) {
      return;
    }

    observerStarted = true;
    document.documentElement.setAttribute("data-viewing-assistant", "");
    if (isVideoDetailPage()) {
      restoreUnfilteredPage();
      return;
    }
    prepareEntriesForFiltering(
      [...document.querySelectorAll("div.thumbnail")]
        .map((card) => ({ item: findLayoutItem(card), card })),
      true,
      location.href
    );
    const observer = new MutationObserver((mutations) => {
      if (!isFilteringActive()) return;
      // Invalidate before inspecting additions: one-card and multi-card grids
      // have different layout boundaries. Style-only updates keep the topology.
      if (mutations.some((mutation) => mutation.type === "childList")) topologyRevision += 1;
      recordHomeGridAdditions(mutations);
      const affectedMutations = mutations.filter(mutationAffectsVideoCards);
      if (affectedMutations.length === 0) return;

      const changedCards = collectMutationCards(affectedMutations);
      if (changedCards.length > 0) {
        for (const card of changedCards) cardSettledRevisions.delete(card);
        noteHomeGridActivity(changedCards);
        prepareEntriesForFiltering(
          changedCards.map((card) => ({ item: findLayoutItem(card), card })),
          true,
          location.href
        );
      }
      scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: OBSERVED_ATTRIBUTES
    });

    const scanAfterLoad = () => {
      requestFullScan();
      setTimeout(requestFullScan, 750);
    };
    window.addEventListener("online", () => {
      retryMetadata();
    });
    if (document.readyState === "complete") scanAfterLoad();
    else window.addEventListener("load", scanAfterLoad, { once: true });

    scheduleScan();
  }

  function startFiltering(capabilities) {
    site = capabilities;
    SettingsStore.load((storedSettings) => {
      settings = storedSettings;

      if (document.documentElement) {
        startObserver();
      } else {
        document.addEventListener("DOMContentLoaded", startObserver, { once: true });
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const changedKeys = SettingsStore.changedSettings(changes);
      if (changedKeys.length === 0) return;

      const nextSettings = { ...settings };
      for (const key of changedKeys) nextSettings[key] = changes[key].newValue;
      settings = sanitizeSettings(nextSettings);
      if (changedKeys.every((key) => key === "showActressNames")) {
        requestFullScan();
        return;
      }
      metadataClient.invalidateUnresolved();
      forgetListWork();
      if (!isFilteringActive()) {
        restoreUnfilteredPage();
        return;
      }
      teardownInfiniteScroll();
      removeRefillItems();
      requestFullScan();
    });
    return () => ({
      pageKind: isVideoDetailPage() ? "detail" : isHomePage() ? "home" : "list"
    });
  }

  let filterStatus;
  const recognition = SiteLibrary.watch(document, () => location.href, (site) => {
    filterStatus = startFiltering(site);
  });
  chrome.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type !== "viewing-assistant-status") return false;
    respond({ ...recognition.check(), ...filterStatus?.() });
    return false;
  });
})();
