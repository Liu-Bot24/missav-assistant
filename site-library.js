(() => {
  "use strict";

  const NAV_ROUTES = new Set([
    "actress", "actresses", "genre", "genres", "maker", "makers", "series",
    "new", "today", "uncensored", "uncensored-leak", "chinese-subtitle", "english-subtitle"
  ]);
  const VIDEO_ID = /^(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:[-_][a-z0-9]+)+$/i;
  const UNSUPPORTED = Object.freeze({ compatible: false, metadata: null });

  function inspect(root, href) {
    let page;
    try { page = new URL(href); } catch { return UNSUPPORTED; }
    if (!["https:", "http:"].includes(page.protocol)) return UNSUPPORTED;

    // A verified adapter keeps the original site's document-start behavior.
    // Other hosts must qualify by structure and never inherit its metadata DB.
    if (page.hostname === "missav.ai" || page.hostname.endsWith(".missav.ai")) {
      return { compatible: true, metadata: "missav" };
    }

    const cards = [];
    for (const card of root.querySelectorAll("div.thumbnail")) {
      if (!card.closest("div.grid")) continue;
      const link = card.querySelector("a[href]");
      if (!link) continue;
      try {
        const target = new URL(link.getAttribute("href"), page);
        if (target.origin !== page.origin || !VIDEO_ID.test(target.pathname.split("/").filter(Boolean).at(-1) ?? "")) continue;
      } catch { continue; }
      cards.push(card);
      if (cards.length === 6) break;
    }
    if (cards.length < 1) return UNSUPPORTED;

    const routes = new Set();
    for (const link of root.querySelectorAll("a[href]")) {
      if (link.closest("div.thumbnail")) continue;
      try {
        const target = new URL(link.getAttribute("href"), page);
        if (target.origin !== page.origin) continue;
        const route = target.pathname.toLowerCase().split("/").filter(Boolean)
          .find((segment) => NAV_ROUTES.has(segment));
        if (route) routes.add(route);
      } catch { continue; }
      if (routes.size >= 2) break;
    }
    if (routes.size < 2) return UNSUPPORTED;

    // A shared thumbnail class alone is insufficient: require the template's
    // corner badge layout or its specific reactive badge/load-more contract.
    const scopes = new Set(cards.map((card) => card.parentElement ?? card));
    let cornerBadge = false;
    let reactiveBadge = false;
    for (const scope of scopes) {
      for (const span of scope.querySelectorAll("span")) {
        if (span.classList.contains("bottom-1") && span.classList.contains("left-1")) cornerBadge = true;
        const condition = span.getAttribute("x-show") ?? span.parentElement?.getAttribute("x-show") ?? "";
        if (/\bitem\.dvd_id\b/.test(condition) && /\bitem\.(?:is_uncensored_leak|has_[a-z_]+_subtitle)\b/.test(condition)) reactiveBadge = true;
      }
    }
    let loadMore = false;
    if (reactiveBadge) {
      for (const control of root.querySelectorAll("button, a")) {
        const action = control.getAttribute("@click.prevent") ?? control.getAttribute("x-on:click.prevent") ?? "";
        if (/^\s*loadMore\(\s*\d+\s*\)\s*;?\s*$/.test(action)) { loadMore = true; break; }
      }
    }
    return cornerBadge || (reactiveBadge && loadMore)
      ? { compatible: true, metadata: null } : UNSUPPORTED;
  }

  function watch(root, getUrl, activate) {
    let current = UNSUPPORTED;
    let observer;
    let timer;
    let started = false;
    const check = () => {
      if (started) return current;
      current = inspect(root, getUrl());
      if (current.compatible) {
        started = true;
        observer?.disconnect();
        if (timer !== undefined) clearTimeout(timer);
        activate(current);
      }
      return current;
    };
    check();
    if (!started) {
      const schedule = () => {
        if (started || timer !== undefined) return;
        timer = setTimeout(() => { timer = undefined; check(); }, 120);
      };
      observer = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) =>
          mutation.target?.closest?.("div.thumbnail") ||
          (mutation.type === "attributes" && (
            mutation.target?.matches?.("div.thumbnail, div.grid") ||
            (mutation.attributeName === "href" && mutation.target?.matches?.("a[href]"))
          )) ||
          [...mutation.addedNodes].some((node) => node.nodeType === 1 && (
            node.matches?.("div.thumbnail, div.grid, a[href]") ||
            node.querySelector?.("div.thumbnail, div.grid, a[href]")
          ))
        );
        if (relevant) schedule();
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "class"] });
      root.addEventListener("DOMContentLoaded", check, { once: true });
    }
    return { check };
  }

  globalThis.MissavSiteLibrary = Object.freeze({ inspect, watch });
})();
