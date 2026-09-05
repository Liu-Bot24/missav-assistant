const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const genreLibrarySource = fs.readFileSync(path.join(__dirname, "..", "genre-library.js"), "utf8");
const HIDDEN_CLASS = "missav-content-filter-hidden";
const SETTLING_GRID_CLASS = "missav-content-filter-grid-settling";

test("性能：长列表的布局定位不会为每张卡重复枚举整个网格", async () => {
  const cards = Array.from({ length: 300 }, (_, index) => makeCard(
    index % 2 ? [] : [{ text: "中文字幕" }]
  ));
  const grid = makePage(cards);
  let gridEnumerations = 0;
  const query = grid.querySelectorAll.bind(grid);
  grid.querySelectorAll = (selector) => {
    if (selector === "div.thumbnail") gridEnumerations += 1;
    return query(selector);
  };
  const runtime = execute(grid, { blockedPresets: ["chinese-subtitle"], genreExcludeRules: [] });
  await new Promise(setImmediate);
  const initialEnumerations = gridEnumerations;
  const added = makeCard([{ text: "中文字幕" }]);
  grid.append(added.wrapper);
  runtime.observer.callback([{ type: "childList", target: grid, addedNodes: [added.wrapper] }]);
  await new Promise(setImmediate);
  assert.equal(added.wrapper.classList.contains(HIDDEN_CLASS), true);
  assert.equal(cards[1].wrapper.classList.contains(HIDDEN_CLASS), false);
  console.log(JSON.stringify({ cards: 300, initialEnumerations, afterInsertion: gridEnumerations }));
  assert.ok(initialEnumerations < 40, `初次遍历网格 ${initialEnumerations} 次`);
  assert.ok(gridEnumerations - initialEnumerations < 40, "新增卡片不应放大全网格枚举次数");
});

class FakeClassList {
  constructor(classes = []) {
    this.values = new Set(classes);
  }

  contains(value) {
    return this.values.has(value);
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor({ tagName = "DIV", textContent = "", classes = [], display = "block", attributes = {} } = {}) {
    this.tagName = tagName;
    this.textContent = textContent;
    this.classList = new FakeClassList(classes);
    this.children = [];
    this.parentElement = null;
    this.nodeType = 1;
    this.hidden = false;
    this.style = { display, visibility: "visible", opacity: "1" };
    this.attributes = new Map(Object.entries(attributes));
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  after(element) {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    element.parentElement = this.parentElement;
    this.parentElement.children.splice(index + 1, 0, element);
  }

  addEventListener(type, listener) {
    this.listeners ??= new Map();
    this.listeners.set(type, listener);
  }

  click() {
    this.listeners?.get("click")?.({ target: this, preventDefault() {} });
  }

  matches(selector) {
    if (selector === "div.thumbnail") return this.tagName === "DIV" && this.classList.contains("thumbnail");
    if (selector === "div.grid") return this.tagName === "DIV" && this.classList.contains("grid");
    if (selector === "a[href]") return this.tagName === "A" && this.attributes.has("href");
    if (selector === "img") return this.tagName === "IMG";
    if (selector === "button") return this.tagName === "BUTTON";
    if (selector === 'a[rel="next"][href]') {
      return this.tagName === "A" && this.getAttribute("rel") === "next" && this.attributes.has("href");
    }
    if (selector === "[data-missav-filter-refill]") return this.attributes.has("data-missav-filter-refill");
    return false;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selector === "span" && child.tagName === "SPAN") matches.push(child);
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    if (selector === "h2") return this.querySelectorAllByTag("H2")[0] ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAllByTag(tagName) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.tagName === tagName) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      if (selector === "div.grid" && current.tagName === "DIV" && current.classList.contains("grid")) return current;
      current = current.parentElement;
    }
    return null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index >= 0 ? this.parentElement.children[index + 1] ?? null : null;
  }

  get href() {
    return this.getAttribute("href");
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  cloneNode(deep = false) {
    const clone = new FakeElement({
      tagName: this.tagName,
      textContent: this.textContent,
      classes: [...this.classList.values],
      display: this.style.display,
      attributes: Object.fromEntries(this.attributes)
    });
    clone.hidden = this.hidden;
    clone.style.visibility = this.style.visibility;
    clone.style.opacity = this.style.opacity;
    if (deep) clone.append(...this.children.map((child) => child.cloneNode(true)));
    return clone;
  }
}

function makeTag(text, display = "block") {
  const holder = new FakeElement({ tagName: "A", display });
  holder.append(new FakeElement({
    tagName: "SPAN",
    textContent: text,
    classes: ["absolute", "bottom-1", "left-1"]
  }));
  return holder;
}

function makeCard(labels = [], { direct = false, imageAttributes = null, href = null } = {}) {
  const card = new FakeElement({ classes: ["thumbnail", "group"] });
  const media = new FakeElement();
  if (href) {
    media.append(new FakeElement({ tagName: "A", attributes: { href } }));
  }
  if (imageAttributes) {
    media.append(new FakeElement({ tagName: "IMG", attributes: imageAttributes }));
  }
  for (const label of labels) media.append(makeTag(label.text, label.display));
  card.append(media, new FakeElement());

  const wrapper = direct ? card : new FakeElement().append(card);
  return { card, wrapper, layoutItem: wrapper };
}

function makeSidebarCard(labels = [], options = {}) {
  const base = makeCard(labels, { ...options, direct: true });
  const title = new FakeElement({ textContent: options.title ?? "视频标题" });
  const wrapper = new FakeElement({ classes: ["grid"] }).append(base.card, title);
  return { card: base.card, wrapper, layoutItem: wrapper, title };
}

function makePage(cards = []) {
  const grid = new FakeElement({ classes: ["grid"] });
  grid.append(...cards.map((item) => item.wrapper));
  return grid;
}

function makeHomeSection(headingText, cards = []) {
  const container = new FakeElement();
  const heading = new FakeElement().append(new FakeElement({ tagName: "H2", textContent: headingText }));
  container.append(heading, makePage(cards));
  return container;
}

function makePaginatedPage(cards, url, nextUrl = null) {
  const root = new FakeElement();
  const grid = makePage(cards);
  root.append(grid);
  if (nextUrl) {
    root.append(new FakeElement({
      tagName: "A",
      attributes: { href: nextUrl, rel: "next" }
    }));
  }
  return { root, grid, url };
}

function execute(root, storedSettings = {}, runtimeOptions = {}) {
  let observer;
  let intersectionObserver;
  let storageListener;
  let documentQueryCount = 0;
  const fetchCalls = [];
  const metadataMessages = [];
  const pendingMetadataCallbacks = [];
  const windowListeners = new Map();
  const scheduledTimeouts = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }
    observe(_target, options) {
      this.options = options;
    }
  }

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      intersectionObserver = this;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const makeDocument = (documentRoot) => ({
    documentElement: documentRoot,
    querySelectorAll(selector) {
      if (documentRoot === root) documentQueryCount += 1;
      return documentRoot.querySelectorAll(selector);
    },
    querySelector: documentRoot.querySelector.bind(documentRoot),
    importNode(node, deep) {
      return node.cloneNode(deep);
    },
    createElement(tagName) {
      return new FakeElement({ tagName: String(tagName).toUpperCase() });
    },
    addEventListener() {}
  });
  const document = makeDocument(root);
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        metadataMessages.push(message);
        if (runtimeOptions.deferMetadata) {
          pendingMetadataCallbacks.push({ message, callback });
          return;
        }
        const items = {};
        for (const itemId of message.itemIds ?? []) {
          items[itemId] = runtimeOptions.metadata?.[itemId] ?? null;
        }
        queueMicrotask(() => callback({ ok: true, items }));
      }
    },
    storage: {
      sync: {
        get(defaults, callback) {
          callback({ ...defaults, ...storedSettings });
        }
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    }
  };

  const context = {
    chrome,
    document,
    MutationObserver: FakeMutationObserver,
    IntersectionObserver: FakeIntersectionObserver,
    queueMicrotask,
    URL,
    location: { href: runtimeOptions.url ?? "https://missav.ai/new?page=1" },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (!runtimeOptions.pages?.[url]) return { ok: false, status: 404 };
      return { ok: true, text: async () => url };
    },
    DOMParser: class {
      parseFromString(pageKey) {
        return makeDocument(runtimeOptions.pages[pageKey]);
      }
    },
    getComputedStyle(element) {
      return element.style;
    },
    window: {
      addEventListener(type, listener) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
      }
    },
    setTimeout(listener, delay = 0) {
      if (delay === 0) {
        queueMicrotask(listener);
        return 0;
      }
      scheduledTimeouts.push(listener);
      return scheduledTimeouts.length;
    }
  };
  vm.runInNewContext(genreLibrarySource, context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "label-library.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "site-library.js"), "utf8"), context);
  vm.runInNewContext(source, context);

  return {
    observer,
    fetchCalls,
    metadataMessages,
    get documentQueryCount() {
      return documentQueryCount;
    },
    resolveNextMetadataBatch() {
      const pending = pendingMetadataCallbacks.shift();
      if (!pending) return false;
      const items = {};
      for (const itemId of pending.message.itemIds ?? []) {
        items[itemId] = runtimeOptions.metadata?.[itemId] ?? null;
      }
      queueMicrotask(() => pending.callback({ ok: true, items }));
      return true;
    },
    triggerWindowLoad() {
      for (const listener of windowListeners.get("load") ?? []) listener();
    },
    runScheduledTimeouts() {
      for (const listener of scheduledTimeouts.splice(0)) listener();
    },
    get intersectionObserver() {
      return intersectionObserver;
    },
    changeSettings(changes) {
      storageListener(changes, "sync");
    }
  };
}

test("默认同时隐藏简体和繁体的无码标签", () => {
  const simplified = makeCard([{ text: "无码影片" }]);
  const traditional = makeCard([{ text: "無碼影片" }]);
  execute(makePage([simplified, traditional]));
  assert.equal(simplified.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(traditional.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("回归：侧栏卡片会连同封面和视频标题作为整行隐藏", async () => {
  const blocked = makeSidebarCard([{ text: "无码影片" }], {
    href: "https://missav.ai/blocked-001",
    title: "应随封面一起隐藏的标题"
  });
  const allowed = makeSidebarCard([], {
    href: "https://missav.ai/allowed-001",
    title: "应保留的普通视频"
  });

  execute(makePage([blocked, allowed]), {
    genreExcludeRules: []
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(blocked.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(allowed.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("回归：侧栏使用不同 CSS 的可见无码徽章仍会被识别", async () => {
  const blocked = makeSidebarCard([], {
    href: "https://missav.ai/blocked-loose-badge"
  });
  blocked.card.children[0].append(new FakeElement({
    tagName: "SPAN",
    textContent: "无码影片",
    classes: ["badge", "sidebar-badge"]
  }));

  execute(makePage([blocked]), { genreExcludeRules: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(blocked.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("详情页完全不处理推荐侧栏，即使保存了标签和分类规则", async () => {
  const uncensored = makeSidebarCard([{ text: "无码影片" }], {
    href: "https://missav.ai/kawd-758"
  });
  const ordinary = makeSidebarCard([], {
    href: "https://missav.ai/ebod-559"
  });
  const includeRule = `value:${encodeURIComponent("巨乳")}`;

  const runtime = execute(makePage([uncensored, ordinary]), {
    blockedPresets: ["uncensored"],
    genreIncludeRules: [includeRule],
    genreExcludeRules: ["group:gender-diverse"]
  }, {
    url: "https://missav.ai/dm123/sone-119",
    metadata: {
      "kawd-758": { genres: ["巨乳"], tags: [], type: "jav", duration: 7200 },
      "ebod-559": { genres: ["素人"], tags: [], type: "jav", duration: 7200 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(uncensored.layoutItem.classList.contains(HIDDEN_CLASS), false);
  assert.equal(ordinary.layoutItem.classList.contains(HIDDEN_CLASS), false);
  assert.equal(runtime.metadataMessages.length, 0);
});

test("可只选择隐藏某一种标签", () => {
  const chinese = makeCard([{ text: "中文字幕" }]);
  const english = makeCard([{ text: "英文字幕" }]);
  const uncensored = makeCard([{ text: "無碼影片" }]);
  execute(makePage([chinese, english, uncensored]), {
    blockedPresets: ["chinese-subtitle"]
  });
  assert.equal(chinese.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(english.layoutItem.classList.contains(HIDDEN_CLASS), false);
  assert.equal(uncensored.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("可隐藏无标签卡片，同时保留未选中的带标签卡片", () => {
  const untagged = makeCard([]);
  const tagged = makeCard([{ text: "中文字幕" }]);
  execute(makePage([untagged, tagged]), {
    blockedPresets: [],
    hideUntagged: true
  });
  assert.equal(untagged.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(tagged.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("栏目标题与导航文字都不会被当成视频卡片标签", () => {
  const ordinary = makeCard([]);
  const root = new FakeElement();
  root.append(
    new FakeElement({ tagName: "SPAN", textContent: "无码影片" }),
    makeHomeSection("無碼影片", [ordinary])
  );
  execute(root, { genreExcludeRules: [] });
  assert.equal(ordinary.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("首页加载完成后会补做一次稳定扫描，识别延迟显示的标签", async () => {
  const card = makeCard([{ text: "无码影片", display: "none" }]);
  const runtime = execute(makeHomeSection("最近更新", [card]), {
    genreExcludeRules: []
  }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), false);

  card.card.children[0].children[0].style.display = "block";
  runtime.triggerWindowLoad();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("首页徽章位于 thumbnail 兄弟节点时仍会被计入筛选", async () => {
  const card = makeCard([]);
  card.wrapper.append(makeTag("无码影片"));

  execute(makeHomeSection("随机", [card]), { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("首页已有卡片后来插入外层标签时会立即重新筛选", async () => {
  const card = makeCard([]);
  const runtime = execute(makeHomeSection("推荐给你", [card]), {
    genreExcludeRules: []
  }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), false);

  const lateBadge = makeTag("无码影片");
  card.wrapper.append(lateBadge);
  runtime.observer.callback([{
    type: "childList",
    target: card.wrapper,
    addedNodes: [lateBadge],
    removedNodes: []
  }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("首页少于八项时载入一批，达到或超过八项立即停止", async () => {
  const initial = [
    makeCard([{ text: "无码影片" }]),
    ...Array.from({ length: 7 }, () => makeCard([]))
  ];
  const section = makeHomeSection("巨乳", initial);
  const grid = section.children[1];
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  section.append(loadMore);
  let clickCount = 0;
  let settlingSeenAtClick = false;
  let runtime;

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    settlingSeenAtClick = grid.classList.contains(SETTLING_GRID_CLASS);
    const replacements = Array.from({ length: 4 }, () => makeCard([]));
    grid.append(...replacements.map((item) => item.wrapper));
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: replacements.map((item) => item.wrapper),
      removedNodes: []
    }]);
  });

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  runtime.runScheduledTimeouts();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 1);
  assert.equal(settlingSeenAtClick, true);
  assert.equal(grid.classList.contains(SETTLING_GRID_CLASS), false);
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    11
  );
  assert.equal(
    grid.children.some((item) => item.classList.contains("missav-content-filter-home-overflow")),
    false
  );

  loadMore.hidden = true;
  runtime.changeSettings({ enabled: { newValue: false } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    12
  );
});

test("首页原本正好八项且无需隐藏时不会载入更多", async () => {
  const section = makeHomeSection(
    "推荐给你",
    Array.from({ length: 8 }, () => makeCard([]))
  );
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  let clickCount = 0;
  loadMore.addEventListener("click", () => {
    clickCount += 1;
  });
  section.append(loadMore);

  execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 0);
});

test("首页隐藏推荐占位卡不计入八个真实视频", async () => {
  const placeholder = makeCard([], { direct: true });
  placeholder.card.setAttribute("x-show", "! recommendItems[0].length");
  placeholder.card.style.display = "none";
  const realCards = Array.from({ length: 7 }, () => makeCard([]));
  const section = makeHomeSection("推荐给你", [placeholder, ...realCards]);
  const grid = section.children[1];
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  let clickCount = 0;
  let runtime;

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    const replacement = makeCard([]);
    grid.append(replacement.wrapper);
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: [replacement.wrapper],
      removedNodes: []
    }]);
  });
  section.append(loadMore);

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 1);
  assert.equal(
    grid.children.filter((item) =>
      item.style.display !== "none" && !item.classList.contains(HIDDEN_CLASS)
    ).length,
    8
  );
});

test("首页推荐占位卡不会把待判定状态挂到整个网格", async () => {
  const placeholder = makeCard([], { direct: true });
  placeholder.card.setAttribute("x-show", "! recommendItems[0].length");
  const grid = makePage([placeholder]);
  grid.append(new FakeElement({ tagName: "TEMPLATE" }));

  execute(grid, {
    genreExcludeRules: ["group:gender-diverse"]
  }, {
    url: "https://missav.ai/dm247/cn",
    deferMetadata: true
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(grid.classList.contains(HIDDEN_CLASS), false);
  assert.equal(grid.classList.contains("missav-content-filter-pending"), false);
  assert.equal(placeholder.card.classList.contains("missav-content-filter-pending"), false);
});

test("首页载入更多首次尚未绑定时会解除占用并重试", async () => {
  const section = makeHomeSection("推荐给你", [makeCard([]), makeCard([])]);
  const grid = section.children[1];
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  section.append(loadMore);
  let clickCount = 0;
  let runtime;

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    const replacements = Array.from({ length: 6 }, () => makeCard([]));
    grid.append(...replacements.map((item) => item.wrapper));
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: replacements.map((item) => item.wrapper),
      removedNodes: []
    }]);
  });

  runtime.runScheduledTimeouts();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 1);
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("首页不足八项时会逐批载入直到达到八项", async () => {
  const section = makeHomeSection("推荐给你", [makeCard([]), makeCard([])]);
  const grid = section.children[1];
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  section.append(loadMore);
  let clickCount = 0;
  let runtime;

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    const replacements = [makeCard([]), makeCard([])];
    grid.append(...replacements.map((item) => item.wrapper));
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: replacements.map((item) => item.wrapper),
      removedNodes: []
    }]);
  });

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 3);
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("首页载入更多被占位容器隔开时仍会为所属栏目补位", async () => {
  const section = makeHomeSection("巨乳", [
    makeCard([{ text: "无码影片" }]),
    ...Array.from({ length: 7 }, () => makeCard([]))
  ]);
  const grid = section.children[1];
  const loadingPlaceholder = new FakeElement({ textContent: "载入中" });
  const controls = new FakeElement();
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  controls.append(loadMore);
  section.append(loadingPlaceholder, controls);
  let clickCount = 0;
  let runtime;

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    const replacement = makeCard([]);
    grid.append(replacement.wrapper);
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: [replacement.wrapper],
      removedNodes: []
    }]);
  });

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 1);
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("首页栏目补位不会跨到下一个栏目的载入更多按钮", async () => {
  const missingSection = makeHomeSection("巨乳", [
    makeCard([{ text: "无码影片" }]),
    ...Array.from({ length: 7 }, () => makeCard([]))
  ]);
  const completeSection = makeHomeSection(
    "潮吹",
    Array.from({ length: 8 }, () => makeCard([]))
  );
  const otherLoadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  let otherClicks = 0;
  otherLoadMore.addEventListener("click", () => {
    otherClicks += 1;
  });
  completeSection.append(otherLoadMore);
  const root = new FakeElement().append(missingSection, completeSection);

  execute(root, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(otherClicks, 0);
});

test("多个首页栏目共用父容器时按文档顺序关联各自载入更多", async () => {
  const firstGrid = makePage([
    ...Array.from({ length: 6 }, () => makeCard([{ text: "无码影片" }])),
    makeCard([]),
    makeCard([])
  ]);
  const secondGrid = makePage(Array.from({ length: 8 }, () => makeCard([])));
  const firstControl = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  const secondControl = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  const root = new FakeElement().append(
    new FakeElement().append(new FakeElement({ tagName: "H2", textContent: "巨乳" })),
    firstGrid,
    new FakeElement({ textContent: "载入中" }),
    firstControl,
    new FakeElement().append(new FakeElement({ tagName: "H2", textContent: "潮吹" })),
    secondGrid,
    secondControl
  );
  let firstClicks = 0;
  let secondClicks = 0;
  let runtime;

  firstControl.addEventListener("click", () => {
    firstClicks += 1;
    const replacements = Array.from({ length: 6 }, () => makeCard([]));
    firstGrid.append(...replacements.map((item) => item.wrapper));
    runtime.observer.callback([{
      type: "childList",
      target: firstGrid,
      addedNodes: replacements.map((item) => item.wrapper),
      removedNodes: []
    }]);
  });
  secondControl.addEventListener("click", () => {
    secondClicks += 1;
  });

  runtime = execute(root, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstClicks, 1);
  assert.equal(secondClicks, 0);
  assert.equal(
    firstGrid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("栏目标题与规则同名且已有八项时不会隐藏或触发补位", async () => {
  const section = makeHomeSection(
    "无码影片",
    Array.from({ length: 8 }, () => makeCard([]))
  );
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  let clickCount = 0;
  loadMore.addEventListener("click", () => {
    clickCount += 1;
  });
  section.append(loadMore);

  execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 0);
  assert.equal(
    section.children[1].children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("普通首页栏目当前一批全部被过滤时仍会继续请求替补", async () => {
  const section = makeHomeSection(
    "潮吹",
    Array.from({ length: 8 }, () => makeCard([{ text: "无码影片" }]))
  );
  const grid = section.children[1];
  const loadMore = new FakeElement({ tagName: "BUTTON", textContent: "载入更多" });
  section.append(loadMore);
  let clickCount = 0;
  let runtime;

  loadMore.addEventListener("click", () => {
    clickCount += 1;
    const replacements = Array.from({ length: 8 }, () => makeCard([]));
    grid.append(...replacements.map((item) => item.wrapper));
    runtime.observer.callback([{
      type: "childList",
      target: grid,
      addedNodes: replacements.map((item) => item.wrapper),
      removedNodes: []
    }]);
  });

  runtime = execute(section, { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clickCount, 1);
  assert.equal(
    grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    8
  );
});

test("忽略动态推荐卡片中 display:none 的预埋标签", () => {
  const recommended = makeCard([
    { text: "無碼影片", display: "none" },
    { text: "中文字幕", display: "block" }
  ], { direct: true });
  execute(makePage([recommended]));
  assert.equal(recommended.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("动态推荐的 uncensored leak 视频在徽章显示前也会隐藏", () => {
  const card = makeCard([{ text: "无码影片", display: "none" }], {
    href: "https://missav.ai/cn/sgki-085-uncensored-leak"
  });

  execute(makePage([card]), { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("普通视频 ID 不会被 uncensored leak 规则误伤", () => {
  const card = makeCard([{ text: "无码影片", display: "none" }], {
    href: "https://missav.ai/cn/sgki-085"
  });

  execute(makePage([card]), { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("动态推荐徽章由 display none 变为可见时会立即重新筛选", async () => {
  const card = makeCard([]);
  const delayedBadge = makeTag("无码影片", "none");
  card.card.children[0].append(delayedBadge);
  const runtime = execute(makePage([card]), { genreExcludeRules: [] }, {
    url: "https://missav.ai/dm247/cn"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), false);

  delayedBadge.style.display = "block";
  runtime.observer.callback([{
    type: "attributes",
    attributeName: "style",
    target: delayedBadge
  }]);

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("导航里的同名文字不会被当成视频卡片", () => {
  const root = new FakeElement();
  root.append(new FakeElement({ tagName: "SPAN", textContent: "無碼影片" }));
  execute(root);
  assert.equal(root.classList.contains(HIDDEN_CLASS), false);
});

test("动态插入卡片后会重新过滤", async () => {
  const page = makePage([]);
  const runtime = execute(page);
  const dynamic = makeCard([{ text: "無碼影片" }]);
  page.append(dynamic.wrapper);
  runtime.observer.callback([{
    type: "childList",
    target: page,
    addedNodes: [dynamic.wrapper],
    removedNodes: []
  }]);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(dynamic.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("性能回归：样式和 class 变化不会重新启动整页两阶段筛选", async () => {
  const card = makeCard([], { href: "https://missav.ai/allowed-001" });
  const runtime = execute(makePage([card]), {
    genreIncludeRules: [`value:${encodeURIComponent("素人")}`],
    genreExcludeRules: []
  }, {
    metadata: {
      "allowed-001": { genres: ["素人"], tags: [], type: "jav", duration: 7200 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const baselineQueries = runtime.documentQueryCount;

  runtime.observer.callback([{
    type: "attributes",
    target: card.card,
    attributeName: "class"
  }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.documentQueryCount, baselineQueries);
  assert.equal(runtime.observer.options.attributes, true);
  assert.equal(Array.from(runtime.observer.options.attributeFilter).join(","), "style");
  assert.equal(runtime.observer.options.characterData, undefined);
});

test("暂停过滤后会恢复之前隐藏的卡片", () => {
  const blocked = makeCard([{ text: "無碼影片" }]);
  const runtime = execute(makePage([blocked]));
  assert.equal(blocked.layoutItem.classList.contains(HIDDEN_CLASS), true);
  runtime.changeSettings({ enabled: { newValue: false } });
  assert.equal(blocked.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("停用的自定义标签不再产生不可见的过滤规则", () => {
  const custom = makeCard([{ text: " 4K " }]);
  execute(makePage([custom]), {
    blockedPresets: [],
    customLabels: ["4k"]
  });
  assert.equal(custom.layoutItem.classList.contains(HIDDEN_CLASS), false);
});

test("回归：过滤 5 项后会从下一页补足到 12 项", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const nextAllowed = Array.from({ length: 7 }, () => makeCard([]));
  const nextBlocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const page6Url = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage([...nextBlocked, ...nextAllowed], page6Url);

  execute(current.root, {}, {
    url: current.url,
    pages: { [page6Url]: page6.root }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const visibleItems = current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS));
  assert.equal(visibleItems.length, 12);
});

test("下一页没有足够候选时会继续读取后续分页", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const page6Url = "https://missav.ai/actress?page=6";
  const page7Url = "https://missav.ai/actress?page=7";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage(
    Array.from({ length: 12 }, () => makeCard([{ text: "無碼影片" }])),
    page6Url,
    page7Url
  );
  const page7 = makePaginatedPage(Array.from({ length: 12 }, () => makeCard([])), page7Url);

  execute(current.root, {}, {
    url: current.url,
    pages: {
      [page6Url]: page6.root,
      [page7Url]: page7.root
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const visibleItems = current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS));
  assert.equal(visibleItems.length, 12);
});

test("设置变化时移除旧补位并按新规则恢复原始 12 项", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const page6Url = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage(Array.from({ length: 12 }, () => makeCard([])), page6Url);
  const runtime = execute(current.root, {}, {
    url: current.url,
    pages: { [page6Url]: page6.root }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.grid.children.length, 17);

  runtime.changeSettings({ enabled: { newValue: false } });
  assert.equal(current.grid.children.length, 12);
  assert.equal(
    current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    12
  );
});

test("后续请求失败时安全停止并保留当前合格项", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const missingUrl = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", missingUrl);
  const runtime = execute(current.root, {}, { url: current.url, pages: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.fetchCalls, [missingUrl]);
  assert.equal(
    current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    7
  );
});

test("连续无合格候选时最多向后请求 8 页", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const pages = {};
  const firstNextUrl = "https://missav.ai/actress?page=6";

  for (let pageNumber = 6; pageNumber <= 13; pageNumber += 1) {
    const url = `https://missav.ai/actress?page=${pageNumber}`;
    const nextUrl = `https://missav.ai/actress?page=${pageNumber + 1}`;
    pages[url] = makePaginatedPage(
      Array.from({ length: 12 }, () => makeCard([{ text: "無碼影片" }])),
      url,
      nextUrl
    ).root;
  }

  const current = makePaginatedPage(
    [...blocked, ...allowed],
    "https://missav.ai/actress?page=5",
    firstNextUrl
  );
  const runtime = execute(current.root, {}, { url: current.url, pages });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.fetchCalls.length, 8);
});

test("回归：补位卡片会把懒加载封面地址写入 src", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const coverUrl = "https://images.example.test/cover.jpg";
  const coverSourceSet = `${coverUrl} 1x, https://images.example.test/cover@2x.jpg 2x`;
  const page6Url = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage(
    Array.from({ length: 12 }, () => makeCard([], {
      imageAttributes: {
        "data-src": coverUrl,
        "data-srcset": coverSourceSet
      }
    })),
    page6Url
  );

  execute(current.root, {}, {
    url: current.url,
    pages: { [page6Url]: page6.root }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const importedImage = current.grid.children[12].querySelector("img");
  assert.equal(importedImage.getAttribute("src"), coverUrl);
  assert.equal(importedImage.getAttribute("srcset"), coverSourceSet);
  assert.equal(importedImage.getAttribute("loading"), "lazy");
  assert.equal(importedImage.getAttribute("decoding"), "async");
});

test("连续滚动模式在触底后追加下一页的全部合格卡片", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const page6Url = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage([...blocked, ...allowed], page6Url);
  const runtime = execute(current.root, { infiniteScroll: true }, {
    url: current.url,
    pages: { [page6Url]: page6.root }
  });
  await new Promise((resolve) => setImmediate(resolve));

  runtime.intersectionObserver.callback([{ isIntersecting: true }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.fetchCalls, [page6Url]);
  assert.equal(current.grid.children.length, 19);
  assert.equal(
    current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    14
  );
});

test("关闭连续滚动后清理追加项并恢复单页补足模式", async () => {
  const blocked = Array.from({ length: 5 }, () => makeCard([{ text: "無碼影片" }]));
  const allowed = Array.from({ length: 7 }, () => makeCard([]));
  const page6Url = "https://missav.ai/actress?page=6";
  const current = makePaginatedPage([...blocked, ...allowed], "https://missav.ai/actress?page=5", page6Url);
  const page6 = makePaginatedPage([...blocked, ...allowed], page6Url);
  const runtime = execute(current.root, { infiniteScroll: true }, {
    url: current.url,
    pages: { [page6Url]: page6.root }
  });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.intersectionObserver.callback([{ isIntersecting: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.grid.children.length, 19);

  runtime.changeSettings({ infiniteScroll: { newValue: false } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(current.grid.children.length, 17);
  assert.equal(
    current.grid.children.filter((item) => !item.classList.contains(HIDDEN_CLASS)).length,
    12
  );
});

test("默认排除组合规则会隐藏命中内页类型的卡片", async () => {
  const detailUrl = "https://missav.ai/pets-071";
  const card = makeCard([], { href: detailUrl });
  const runtime = execute(makePage([card]), {}, {
    metadata: {
      "pets-071": {
        genres: ["女装・男の娘", "ニューハーフ"],
        tags: [],
        type: "jav"
      }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runtime.metadataMessages.length, 1);
  assert.deepEqual(Array.from(runtime.metadataMessages[0].itemIds), ["pets-071"]);
  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("包含规则要求至少命中一项，排除规则具有更高优先级", async () => {
  const allowed = makeCard([], { href: "https://missav.ai/allowed-001" });
  const missingInclude = makeCard([], { href: "https://missav.ai/missing-001" });
  const excluded = makeCard([], { href: "https://missav.ai/excluded-001" });
  const includeRule = `value:${encodeURIComponent("素人")}`;

  execute(makePage([allowed, missingInclude, excluded]), {
    genreIncludeRules: [includeRule],
    genreExcludeRules: ["group:gender-diverse"]
  }, {
    metadata: {
      "allowed-001": { genres: ["素人"], tags: [], type: "jav" },
      "missing-001": { genres: ["巨乳"], tags: [], type: "jav" },
      "excluded-001": { genres: ["素人", "女装・男の娘"], tags: [], type: "jav" }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(allowed.layoutItem.classList.contains(HIDDEN_CLASS), false);
  assert.equal(missingInclude.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(excluded.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("回归：必须包含四小时以上时只保留时长达到 14400 秒的卡片", async () => {
  const fourHoursPlus = makeCard([], { href: "https://missav.ai/mizd-396" });
  const twoHours = makeCard([], { href: "https://missav.ai/mida-737" });
  const legacyDurationRule = `value:${encodeURIComponent("4小時以上")}`;

  execute(makePage([fourHoursPlus, twoHours]), {
    genreIncludeRules: [legacyDurationRule],
    genreExcludeRules: []
  }, {
    metadata: {
      "mizd-396": { genres: ["女優ベスト・総集編"], tags: [], type: "jav", duration: 14438 },
      "mida-737": { genres: ["単体作品"], tags: [], type: "jav", duration: 7279 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fourHoursPlus.layoutItem.classList.contains(HIDDEN_CLASS), false);
  assert.equal(twoHours.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("两阶段管线先固定第一层幸存集合，第二层整批返回后才补位", async () => {
  const blocked = makeCard([{ text: "無碼影片" }], {
    href: "https://missav.ai/blocked-001"
  });
  const survivors = Array.from({ length: 11 }, (_, index) =>
    makeCard([], { href: `https://missav.ai/survivor-${index + 1}` })
  );
  const nextPageUrl = "https://missav.ai/list?page=2";
  const current = makePaginatedPage(
    [blocked, ...survivors],
    "https://missav.ai/list?page=1",
    nextPageUrl
  );
  const nextPage = makePaginatedPage(
    Array.from({ length: 12 }, (_, index) =>
      makeCard([], { href: `https://missav.ai/next-${index + 1}` })
    ),
    nextPageUrl
  );
  const metadata = Object.fromEntries([
    ...survivors.map((_, index) => [
      `survivor-${index + 1}`,
      { genres: [], tags: [], type: "jav", duration: index < 7 ? 14400 : 7200 }
    ]),
    ...Array.from({ length: 12 }, (_, index) => [
      `next-${index + 1}`,
      { genres: [], tags: [], type: "jav", duration: 14400 }
    ])
  ]);
  const runtime = execute(current.root, {
    genreIncludeRules: ["group:duration-4h-plus"],
    genreExcludeRules: []
  }, {
    url: current.url,
    pages: { [nextPageUrl]: nextPage.root },
    metadata,
    deferMetadata: true
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(blocked.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(runtime.metadataMessages.length, 1);
  assert.equal(runtime.metadataMessages[0].itemIds.includes("blocked-001"), false);
  assert.equal(runtime.metadataMessages[0].itemIds.length, 11);
  assert.deepEqual(runtime.fetchCalls, []);

  assert.equal(runtime.resolveNextMetadataBatch(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.fetchCalls, [nextPageUrl]);
  assert.equal(
    survivors.filter((item) => !item.layoutItem.classList.contains(HIDDEN_CLASS)).length,
    7
  );
});

test("分类请求进行中新增的可见标签卡片会同步隐藏", async () => {
  const initial = makeCard([], {
    href: "https://missav.ai/cn/slow-001"
  });
  const grid = makePage([initial]);
  const runtime = execute(grid, {
    genreExcludeRules: ["group:gender-diverse"]
  }, {
    url: "https://missav.ai/dm247/cn",
    deferMetadata: true,
    metadata: {
      "slow-001": { genres: ["素人"], tags: [], type: "jav", duration: 7200 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const lateBlocked = makeCard([{ text: "无码影片" }], {
    href: "https://missav.ai/cn/late-uncensored-001"
  });
  grid.append(lateBlocked.wrapper);
  runtime.observer.callback([{
    type: "childList",
    target: grid,
    addedNodes: [lateBlocked.wrapper],
    removedNodes: []
  }]);

  assert.equal(lateBlocked.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("已被分类隐藏的卡片在后续扫描中不会短暂恢复", async () => {
  const excluded = makeCard([], {
    href: "https://missav.ai/cn/excluded-001"
  });
  const grid = makePage([excluded]);
  const runtime = execute(grid, {
    genreExcludeRules: ["group:gender-diverse"]
  }, {
    url: "https://missav.ai/dm247/cn",
    metadata: {
      "excluded-001": { genres: ["變性者"], tags: [], type: "jav", duration: 7200 },
      "allowed-001": { genres: ["素人"], tags: [], type: "jav", duration: 7200 }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(excluded.layoutItem.classList.contains(HIDDEN_CLASS), true);

  const transitions = [];
  const originalToggle = excluded.layoutItem.classList.toggle.bind(excluded.layoutItem.classList);
  excluded.layoutItem.classList.toggle = (value, force) => {
    if (value === HIDDEN_CLASS) transitions.push(force);
    originalToggle(value, force);
  };

  const allowed = makeCard([], {
    href: "https://missav.ai/cn/allowed-001"
  });
  grid.append(allowed.wrapper);
  runtime.observer.callback([{
    type: "childList",
    target: grid,
    addedNodes: [allowed.wrapper],
    removedNodes: []
  }]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transitions.includes(false), false);
  assert.equal(excluded.layoutItem.classList.contains(HIDDEN_CLASS), true);
});

test("已被可见标签屏蔽的卡片不会触发类型查询", async () => {
  const card = makeCard([{ text: "無碼影片" }], {
    href: "https://missav.ai/blocked-001"
  });
  const runtime = execute(makePage([card]));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.layoutItem.classList.contains(HIDDEN_CLASS), true);
  assert.equal(runtime.metadataMessages.length, 0);
});

const badgeLocales = [
  ["无码影片", "中文字幕", "英文字幕"],
  ["無碼影片", "中文字幕", "英文字幕"],
  ["Uncensored", "Chinese subtitle", "English subtitle"],
  ["無修正", "中国語字幕", "英語字幕"],
  ["일본노모", "중국어 자막", "영어 자막"],
  ["Tidak ditapis", "Sari kata bahasa Cina", "Sari kata bahasa Inggeris"],
  ["ไม่เซ็นเซอร์", "คำบรรยายภาษาจีน", "คำบรรยายภาษาอังกฤษ"],
  ["Unzensiert", "chinesischer Untertitel", "Englischer Untertitel"],
  ["Non censuré", "Sous-titres chinois", "Sous-titre anglais"],
  ["Không kiểm duyệt", "phụ đề tiếng trung", "Phụ đề tiếng anh"],
  ["Tanpa sensor", "subjudul Cina", "Subtitle bahasa inggris"],
  ["Hindi na-censor", "Chinese subtitle", "English subtitle"],
  ["Sem censura", "Legenda chinesa", "Legenda em inglês"]
];
for (const [index, preset] of ["uncensored", "chinese-subtitle", "other-subtitle"].entries()) {
  test(`13 种界面中的 ${preset} 标签独立识别，不混淆其余类别`, () => {
    const cards = badgeLocales.flatMap((row) => row.map((text) => makeCard([{ text }])));
    execute(makePage(cards), { blockedPresets: [preset], genreExcludeRules: [] });
    cards.forEach((card, i) => assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), i % 3 === index));
  });
}

test("英文旧设置迁移到其他字幕，保留中文卡片", () => {
  const en = makeCard([{ text: "英語字幕" }]);
  const cn = makeCard([{ text: "中国語字幕" }]);
  execute(makePage([en, cn]), { blockedPresets: ["english-subtitle"], genreExcludeRules: [] });
  assert.equal(en.wrapper.classList.contains(HIDDEN_CLASS), true);
  assert.equal(cn.wrapper.classList.contains(HIDDEN_CLASS), false);
});

test("徽章结构字段识别字幕种类，否定字幕条件的无码谓词不误识别", () => {
  const conditions = [
    "item.dvd_id && item.has_english_subtitle",
    "item.dvd_id && isChinese && item.has_chinese_subtitle",
    "item.dvd_id && ! (isChinese && item.has_chinese_subtitle) && ! (! isChinese && item.has_english_subtitle) && item.is_uncensored_leak",
    // Synthetic future field: a compatibility check, not a claim that it exists on the live site.
    "item.dvd_id && item.has_korean_subtitle"
  ];
  for (const preset of ["uncensored", "chinese-subtitle", "other-subtitle"]) {
    const cards = conditions.map((condition) => {
      const card = makeCard([{ text: "未收录译名" }]);
      card.card.querySelector("span").parentElement.setAttribute("x-show", condition);
      return card;
    });
    execute(makePage(cards), { blockedPresets: [preset], genreExcludeRules: [] });
    cards.forEach((card, i) => assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS),
      ["other-subtitle", "chinese-subtitle", "uncensored", "other-subtitle"][i] === preset));
  }
});

test("同名标题、部分相似标签和隐藏预埋徽章都不触发标签过滤", () => {
  const title = makeCard([]);
  title.card.append(new FakeElement({ tagName: "SPAN", textContent: "Uncensored" }));
  const similar = makeCard([{ text: "Not Uncensored" }]);
  const invisible = makeCard([{ text: "英語字幕", display: "none" }]);
  const cards = [title, similar, invisible];
  execute(makePage(cards), { blockedPresets: ["uncensored", "other-subtitle"], genreExcludeRules: [] });
  cards.forEach((card) => assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), false));
});

test("非中英文载入更多按网站动作识别，不误点其他操作", async () => {
  for (const [text, action, expected] of [["Mehr laden", "loadMore(0)", 1], ["もっと読み込む", "", 1],
    ["Mehr laden", "loadAdvertisement(0)", 0], ["load more advertisements", "", 0]]) {
    const section = makeHomeSection("栏目", Array.from({ length: 7 }, () => makeCard([])));
    const control = new FakeElement({ tagName: "BUTTON", textContent: text,
      attributes: { "@click.prevent": action } });
    let clicks = 0;
    control.addEventListener("click", () => { clicks += 1; });
    section.append(control);
    execute(section, { genreExcludeRules: [] }, { url: "https://missav.ai/dm285/ja" });
    await new Promise(setImmediate);
    assert.equal(clicks, expected, `${text}: ${action}`);
  }
});

test("空白徽章仍属于无标签，真正的可见徽章不属于无标签", () => {
  const blank = makeCard([{ text: "  " }]);
  const tagged = makeCard([{ text: "English subtitle" }]);
  execute(makePage([blank, tagged]), { hideUntagged: true, blockedPresets: [], genreExcludeRules: [] });
  assert.equal(blank.wrapper.classList.contains(HIDDEN_CLASS), true);
  assert.equal(tagged.wrapper.classList.contains(HIDDEN_CLASS), false);
});

test("关闭首页生效覆盖全部语言首页，但不影响演员、分类及字幕列表", async () => {
  const homes = ['/', '/dm247', '/dm247/', ...['cn','en','ja','ko','ms','th','de','fr','vi','id','fil','pt'].flatMap(l => [`/${l}`, `/dm247/${l}/?from=test`])];
  const lists = ['/cn/actresses', '/dm247/en/genres', '/dm247/ja/new', '/cn/chinese-subtitle', '/en/english-subtitle'];
  for (const [paths, hidden] of [[homes, false], [lists, true]]) {
    for (const route of paths) {
      const card = makeCard([{ text: 'Uncensored' }]);
      const runtime = execute(makeHomeSection('栏目', [card]), { homepageEnabled: false, genreExcludeRules: [] }, { url: `https://missav.ai${route}` });
      await new Promise(setImmediate);
      assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), hidden, route);
      assert.equal(runtime.metadataMessages.length, 0);
    }
  }
});

test("首页初始关闭时不查分类、不补位、不接管连续滚动，开启后新卡仍可筛选", async () => {
  const cards = Array.from({ length: 7 }, (_, i) => makeCard([], { href: `https://missav.ai/test-${i}` }));
  const section = makeHomeSection('栏目', cards);
  const control = new FakeElement({ tagName: 'BUTTON', textContent: '载入更多' });
  let clicks = 0;
  control.addEventListener('click', () => { clicks += 1; });
  section.append(control, new FakeElement({ tagName: 'A', attributes: { rel: 'next', href: 'https://missav.ai/cn?page=2' } }));
  const runtime = execute(section, { homepageEnabled: false, infiniteScroll: true }, { url: 'https://missav.ai/cn' });
  runtime.triggerWindowLoad();
  runtime.runScheduledTimeouts();
  await new Promise(setImmediate);
  assert.equal(runtime.metadataMessages.length, 0);
  assert.equal(runtime.fetchCalls.length, 0);
  assert.equal(runtime.intersectionObserver, undefined);
  assert.equal(clicks, 0);
  assert.equal(section.children[1].classList.contains(SETTLING_GRID_CLASS), false);
  runtime.changeSettings({ homepageEnabled: { newValue: true }, genreExcludeRules: { newValue: [] } });
  const added = makeCard([{ text: '无码影片' }]);
  section.children[1].append(added.wrapper);
  runtime.observer.callback([{ type: 'childList', target: section.children[1], addedNodes: [added.wrapper] }]);
  assert.equal(added.wrapper.classList.contains(HIDDEN_CLASS), true);
});

test("关闭首页会立即恢复待判定卡片，旧分类响应不得重新隐藏", async () => {
  const card = makeCard([], { href: 'https://missav.ai/sample-101' });
  const section = makeHomeSection('栏目', [card]);
  const runtime = execute(section, { genreExcludeRules: ['value:blocked'] }, {
    url: 'https://missav.ai/cn', deferMetadata: true,
    metadata: { 'sample-101': { genres: ['blocked'] } }
  });
  await new Promise(setImmediate);
  assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), true);
  assert.equal(runtime.metadataMessages.length, 1);
  runtime.changeSettings({ homepageEnabled: { newValue: false } });
  assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), false);
  runtime.resolveNextMetadataBatch();
  runtime.runScheduledTimeouts();
  await new Promise(setImmediate);
  assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), false);
  runtime.changeSettings({ homepageEnabled: { newValue: true } });
  await new Promise(setImmediate);
  assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), true);
});

test("关闭首页解除补位遮罩，旧计时器及后到卡片不再筛选或继续点击", async () => {
  const cards = Array.from({ length: 8 }, (_, i) => makeCard(i < 2 ? [{ text: '无码影片' }] : []));
  const section = makeHomeSection('栏目', cards);
  const grid = section.children[1];
  const control = new FakeElement({ tagName: 'BUTTON', textContent: '载入更多' });
  let clicks = 0;
  control.addEventListener('click', () => { clicks += 1; });
  section.append(control);
  const runtime = execute(section, { genreExcludeRules: [] }, { url: 'https://missav.ai/cn' });
  await new Promise(setImmediate);
  assert.equal(grid.classList.contains(SETTLING_GRID_CLASS), true);
  assert.equal(clicks, 1);
  runtime.changeSettings({ homepageEnabled: { newValue: false } });
  assert.equal(grid.classList.contains(SETTLING_GRID_CLASS), false);
  assert.equal(control.classList.contains('missav-content-filter-control-busy'), false);
  cards.forEach(card => assert.equal(card.wrapper.classList.contains(HIDDEN_CLASS), false));
  const late = makeCard([{ text: '无码影片' }]);
  grid.append(late.wrapper);
  runtime.observer.callback([{ type: 'childList', target: grid, addedNodes: [late.wrapper] }]);
  runtime.runScheduledTimeouts();
  await new Promise(setImmediate);
  assert.equal(late.wrapper.classList.contains(HIDDEN_CLASS), false);
  assert.equal(clicks, 1);
});


test("分页补位不跟随指向外站的下一页链接", async () => {
  const cards = [makeCard([{ text: "中文字幕" }]), makeCard([])];
  const page = makePaginatedPage(cards, "https://missav.ai/cn/new", "https://other.test/cn/new?page=2");
  const runtime = execute(page.root, { blockedPresets: ["chinese-subtitle"], genreExcludeRules: [] }, { url: page.url });
  await new Promise(setImmediate);
  assert.equal(cards[0].wrapper.classList.contains(HIDDEN_CLASS), true);
  assert.equal(cards[1].wrapper.classList.contains(HIDDEN_CLASS), false);
  assert.equal(runtime.fetchCalls.length, 0);
});
