(() => {
  "use strict";

  let site;
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    homepageEnabled: true,
    hideUntagged: false,
    infiniteScroll: false,
    blockedPresets: ["uncensored"],
    genreIncludeRules: [],
    genreExcludeRules: ["group:gender-diverse"]
  });
  const LIST_ROUTE_SEGMENTS = new Set([
    "actress", "actresses", "genre", "genres", "label", "labels",
    "maker", "makers", "search", "series", "tag", "tags"
  ]);
  const VIDEO_SLUG_PATTERN = /^(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:[-_][a-z0-9]+)+$/i;
  const HIDDEN_CLASS = "missav-content-filter-hidden";
  const LABEL_HIDDEN_CLASS = "missav-content-filter-label-hidden";
  const GENRE_HIDDEN_CLASS = "missav-content-filter-genre-hidden";
  const PENDING_CLASS = "missav-content-filter-pending";
  const SETTLING_GRID_CLASS = "missav-content-filter-grid-settling";
  const BUSY_CONTROL_CLASS = "missav-content-filter-control-busy";
  const REFILL_ATTRIBUTE = "data-missav-filter-refill";
  const MAX_REFILL_PAGES = 8;
  const MAX_HOME_REFILL_CLICKS = 8;
  const MAX_CONCURRENT_HOME_REFILLS = 1;
  const MIN_HOME_VISIBLE_ITEMS = 8;
  const HOME_REFILL_ACK_TIMEOUT_MS = 500;
  const HOME_REFILL_RESPONSE_TIMEOUT_MS = 15000;
  const HOME_GRID_REVEAL_QUIET_MS = 1800;
  const pageHtmlCache = new Map();
  const metadataPromises = new Map();
  const metadataResults = new Map();
  const cardDecisionRevisions = new WeakMap();
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
  let refillInProgress = false;
  let refillRequested = false;
  let filterRevision = 0;
  let infiniteObserver = null;
  let infiniteSentinel = null;
  let infiniteGrid = null;
  let infiniteNextPageUrl = null;
  let infiniteLoading = false;
  let infiniteSeenCardKeys = new Set();

  function normalizeText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim()
      .toLocaleLowerCase();
  }

  function isVideoDetailPage(url = location.href) {
    try {
      const segments = new URL(url).pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLocaleLowerCase());
      const slug = segments.at(-1) ?? "";
      if (!VIDEO_SLUG_PATTERN.test(slug)) return false;
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

  function sanitizeSettings(value) {
    const sanitizeGenreRules = (rules, fallback) => Array.isArray(rules)
      ? [...new Set(rules.map(MissavGenreLibrary.normalizeRule).filter(Boolean))]
      : [...fallback];

    return {
      enabled: value?.enabled !== false,
      homepageEnabled: value?.homepageEnabled !== false,
      hideUntagged: value?.hideUntagged === true,
      infiniteScroll: value?.infiniteScroll === true,
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
    if (!settings.blockedPresets.includes("uncensored")) return false;
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
      const kind = MissavLabelLibrary.classifyCondition(condition) ??
        MissavLabelLibrary.classifyText(label.textContent);
      return kind !== null && settings.blockedPresets.includes(kind);
    });
  }

  function syncCardHiddenState(card) {
    const layoutItem = findLayoutItem(card);
    const hidden =
      layoutItem.classList.contains(LABEL_HIDDEN_CLASS) ||
      layoutItem.classList.contains(GENRE_HIDDEN_CLASS) ||
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
    layoutItem.classList.toggle(GENRE_HIDDEN_CLASS, false);
    layoutItem.classList.toggle(PENDING_CLASS, false);
    syncCardHiddenState(card);
    cardDecisionRevisions.delete(card);
  }

  function markCardDecisionComplete(card) {
    cardDecisionRevisions.set(card, filterRevision);
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
      setCardPending(card, false);
      setCardHiddenForReason(card, GENRE_HIDDEN_CLASS, false);
      markCardDecisionComplete(card);
    }

    if (!isFilteringActive() || !genreFilteringEnabled()) {
      for (const { card } of visibleEligible) {
        setCardPending(card, false);
        setCardHiddenForReason(card, GENRE_HIDDEN_CLASS, false);
        markCardDecisionComplete(card);
      }
      return visibleEligible;
    }

    for (const { card } of visibleEligible) {
      const itemId = getCardItemId(card, baseUrl);
      if (!itemId) {
        setCardPending(card, false);
        setCardHiddenForReason(card, GENRE_HIDDEN_CLASS, false);
        markCardDecisionComplete(card);
      } else if (metadataResults.has(itemId)) {
        setCardHiddenForReason(
          card,
          GENRE_HIDDEN_CLASS,
          !metadataPassesGenreRules(metadataResults.get(itemId))
        );
        setCardPending(card, false);
        markCardDecisionComplete(card);
      } else {
        cardDecisionRevisions.delete(card);
        setCardPending(card, true);
      }
    }

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

  function genreFilteringEnabled() {
    return site.metadata === "missav" && (
      settings.genreIncludeRules.length > 0 ||
      settings.genreExcludeRules.length > 0
    );
  }

  function metadataValues(metadata) {
    if (!metadata) return [];
    return [
      ...(Array.isArray(metadata.genres) ? metadata.genres : []),
      ...(Array.isArray(metadata.tags) ? metadata.tags : []),
      ...(metadata.type ? [metadata.type] : [])
    ];
  }

  function metadataPassesGenreRules(metadata) {
    if (!metadata) return true;

    const values = metadataValues(metadata);
    const excluded = settings.genreExcludeRules.some((rule) =>
      MissavGenreLibrary.matches(rule, values, metadata)
    );
    if (excluded) return false;

    return (
      settings.genreIncludeRules.length === 0 ||
      settings.genreIncludeRules.some((rule) =>
        MissavGenreLibrary.matches(rule, values, metadata)
      )
    );
  }

  function sendMetadataQuery(itemIds) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "missav-query-metadata", itemIds },
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

  async function ensureMetadata(itemIds) {
    const uniqueIds = [...new Set(itemIds.filter(Boolean))];
    const missingIds = uniqueIds.filter((id) => !metadataPromises.has(id));

    for (let offset = 0; offset < missingIds.length; offset += 30) {
      const batchIds = missingIds.slice(offset, offset + 30);
      const batchPromise = sendMetadataQuery(batchIds);
      for (const id of batchIds) {
        metadataPromises.set(
          id,
          batchPromise.then((items) => {
            const metadata = items[id] ?? null;
            metadataResults.set(id, metadata);
            return metadata;
          })
        );
      }
    }

    const pairs = await Promise.all(uniqueIds.map(async (id) => [
      id,
      await metadataPromises.get(id)
    ]));
    return Object.fromEntries(pairs);
  }

  async function filterEntriesByAllRules(entries, baseUrl, revision) {
    const visibleEligible = applyVisibleLabelStage(entries, false);
    if (!isFilteringActive() || !genreFilteringEnabled() || visibleEligible.length === 0) {
      return visibleEligible;
    }

    const withIds = visibleEligible.map((entry) => ({
      ...entry,
      itemId: getCardItemId(entry.card, baseUrl)
    }));
    const byId = await ensureMetadata(withIds.map(({ itemId }) => itemId));
    if (revision !== filterRevision) return [];

    return withIds.filter(({ itemId }) =>
      !itemId || metadataPassesGenreRules(byId[itemId])
    );
  }

  async function filterCurrentDocument(revision) {
    const entries = [...document.querySelectorAll("div.thumbnail")]
      .map((card) => ({ item: findLayoutItem(card), card }));
    const visibleEligible = prepareEntriesForFiltering(entries, true, location.href);

    if (!isFilteringActive() || !genreFilteringEnabled() || visibleEligible.length === 0) {
      return revision === filterRevision;
    }

    const withIds = visibleEligible.map((entry) => ({
      ...entry,
      itemId: getCardItemId(entry.card, location.href)
    }));
    const byId = await ensureMetadata(withIds.map(({ itemId }) => itemId));
    if (revision !== filterRevision) return false;

    for (const { card, itemId } of withIds) {
      setCardHiddenForReason(
        card,
        GENRE_HIDDEN_CLASS,
        Boolean(itemId) && !metadataPassesGenreRules(byId[itemId])
      );
      setCardPending(card, false);
      markCardDecisionComplete(card);
    }
    return true;
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

  function isHomeGridFullyProcessed(grid) {
    return getHomeContentEntries(grid)
      .every(({ card }) => cardDecisionRevisions.get(card) === filterRevision);
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
      const terminal =
        getVisibleHomeGridCount(grid) >= MIN_HOME_VISIBLE_ITEMS ||
        !currentControl ||
        attempts >= MAX_HOME_REFILL_CLICKS;
      if (
        !homeGridPending.has(grid) &&
        isHomeGridFullyProcessed(grid) &&
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
      const fullyProcessed = isHomeGridFullyProcessed(grid);
      const attempts = homeGridAttempts.get(grid) ?? 0;

      if (!isFilteringActive()) {
        if (!homeGridPending.has(grid)) {
          setHomeGridSettling(grid, control, false);
        }
        continue;
      }

      if (!fullyProcessed) {
        if (control || grid.classList.contains(SETTLING_GRID_CLASS)) {
          setHomeGridSettling(grid, control, true);
        }
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

  function appendImportedItem(grid, item) {
    const importedItem = document.importNode(item, true);
    importedItem.setAttribute(REFILL_ATTRIBUTE, "true");
    activateImportedImages(importedItem);
    const importedCard = getCardFromGridItem(importedItem);
    clearCardFilterState(importedCard);
    grid.append(importedItem);
    topologyRevision += 1;
  }

  async function fetchPageDocument(url) {
    let html = pageHtmlCache.get(url);

    if (!html) {
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) return null;
        html = await response.text();
        pageHtmlCache.set(url, html);
      } catch {
        return null;
      }
    }

    const parsed = new DOMParser().parseFromString(html, "text/html");
    return MissavSiteLibrary.inspect(parsed, url).compatible ? parsed : null;
  }

  async function refillPaginatedGrid(revision) {
    if (!isFilteringActive() || revision !== filterRevision) return;

    const basePageUrl = location.href;
    let nextPageUrl = getNextPageUrl(document, basePageUrl);
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
      const pageDocument = await fetchPageDocument(nextPageUrl);
      if (!pageDocument || revision !== filterRevision) return;

      const sourceGrid = findPaginatedGrid(pageDocument);
      if (!sourceGrid) return;

      const eligibleEntries = await filterEntriesByAllRules(
        getGridItems(sourceGrid),
        nextPageUrl,
        revision
      );
      if (revision !== filterRevision) return;

      for (const { item, card } of eligibleEntries) {

        const cardKey = getCardKey(card, nextPageUrl);
        if (cardKey && seenCardKeys.has(cardKey)) continue;

        appendImportedItem(grid, item);

        if (cardKey) seenCardKeys.add(cardKey);
        visibleCount += 1;
        if (visibleCount >= targetSize) break;
      }

      nextPageUrl = getNextPageUrl(pageDocument, nextPageUrl);
    }
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
      !infiniteGrid ||
      !infiniteNextPageUrl ||
      revision !== filterRevision ||
      !isFilteringActive() ||
      !settings.infiniteScroll
    ) {
      return;
    }

    infiniteLoading = true;
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
        const pageDocument = await fetchPageDocument(pageUrl);
        if (!pageDocument) {
          setInfiniteStatus("加载失败，点击这里重试", "error");
          return;
        }

        checkedPages += 1;
        const sourceGrid = findPaginatedGrid(pageDocument);
        infiniteNextPageUrl = getNextPageUrl(pageDocument, pageUrl);
        if (!sourceGrid) continue;

        const eligibleEntries = await filterEntriesByAllRules(
          getGridItems(sourceGrid),
          pageUrl,
          revision
        );
        if (revision !== filterRevision) return;

        for (const { item, card } of eligibleEntries) {

          const cardKey = getCardKey(card, pageUrl);
          if (cardKey && infiniteSeenCardKeys.has(cardKey)) continue;

          appendImportedItem(infiniteGrid, item);
          if (cardKey) infiniteSeenCardKeys.add(cardKey);
          appendedCount += 1;
        }
      }

      if (!infiniteNextPageUrl) {
        setInfiniteStatus("已经到底了", "complete");
        infiniteObserver?.disconnect();
      } else if (appendedCount === 0) {
        setInfiniteStatus("连续 8 页没有符合规则的内容，点击继续查找", "error");
      } else {
        setInfiniteStatus("继续向下滚动", "idle");
        infiniteObserver?.unobserve(infiniteSentinel);
        infiniteObserver?.observe(infiniteSentinel);
      }
    } finally {
      infiniteLoading = false;
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
    infiniteSentinel.className = "missav-content-filter-sentinel";
    infiniteSentinel.textContent = "继续向下滚动";
    infiniteSentinel.addEventListener("click", () => {
      void loadNextInfiniteBatch(filterRevision);
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
  }

  async function runWorkLoop() {
    if (refillInProgress) return;

    refillInProgress = true;
    try {
      while (refillRequested) {
        refillRequested = false;
        if (!isFilteringActive()) {
          restoreUnfilteredPage();
          continue;
        }
        const revision = filterRevision;
        const settled = await filterCurrentDocument(revision);
        if (!settled || revision !== filterRevision) continue;
        refillHomeGrids();
        if (isFilteringActive() && settings.infiniteScroll) {
          setupInfiniteScroll(revision);
        } else {
          teardownInfiniteScroll();
          await refillPaginatedGrid(revision);
        }
      }
    } finally {
      refillInProgress = false;
      if (refillRequested) scheduleScan();
    }
  }

  function scheduleScan() {
    refillRequested = true;
    if (scanScheduled || refillInProgress) return;

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
    if (isInsideRefillItem(mutation?.target)) {
      return false;
    }

    if (mutation?.type === "attributes") {
      if (mutation.attributeName !== "style") return false;
      const target = mutation.target?.nodeType === 1
        ? mutation.target
        : mutation.target?.parentElement;
      if (!target) return false;
      const possibleBadges = [
        ...(target.matches?.("span") ? [target] : []),
        ...(target.querySelectorAll?.("span") ?? [])
      ];
      return possibleBadges.some(isBadge) && (
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
        let item = target;
        while (item.parentElement && item.parentElement !== grid) {
          item = item.parentElement;
        }
        const card = item.parentElement === grid ? getCardFromGridItem(item) : null;
        if (card) cards.add(card);
      }

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
      attributeFilter: ["style"]
    });

    const scanAfterLoad = () => {
      scheduleScan();
      setTimeout(scheduleScan, 750);
    };
    if (document.readyState === "complete") scanAfterLoad();
    else window.addEventListener("load", scanAfterLoad, { once: true });

    scheduleScan();
  }

  function startFiltering(capabilities) {
    site = capabilities;
    chrome.storage.sync.get(DEFAULT_SETTINGS, (storedSettings) => {
      settings = sanitizeSettings(storedSettings);

      if (document.documentElement) {
        startObserver();
      } else {
        document.addEventListener("DOMContentLoaded", startObserver, { once: true });
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      const nextSettings = { ...settings };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) {
          nextSettings[key] = changes[key].newValue;
        }
      }

      settings = sanitizeSettings(nextSettings);
      filterRevision += 1;
      topologyRevision += 1;
      if (!isFilteringActive()) {
        restoreUnfilteredPage();
        return;
      }
      teardownInfiniteScroll();
      removeRefillItems();
      prepareEntriesForFiltering(
        [...document.querySelectorAll("div.thumbnail")]
          .map((card) => ({ item: findLayoutItem(card), card })),
        true,
        location.href
      );
      scheduleScan();
    });
    return () => ({
      pageKind: isVideoDetailPage() ? "detail" : isHomePage() ? "home" : "list"
    });
  }

  let filterStatus;
  const recognition = MissavSiteLibrary.watch(document, () => location.href, (site) => {
    filterStatus = startFiltering(site);
  });
  chrome.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type !== "viewing-assistant-status") return false;
    respond({ ...recognition.check(), ...filterStatus?.() });
    return false;
  });
})();
