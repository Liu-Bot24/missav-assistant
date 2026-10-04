"use strict";

importScripts("genre-library.js", "actress-data.js", "actress-library.js");

const DATABASE_ID = "missav-default";
const API_HOST = "https://client-rapi-missav.recombee.com";
const PUBLIC_TOKEN = "Ikkg568nlM51RHvldlPvc2GzZPE9R4XGzaH9Qj4zK9npbbbTly1gj9K4mgRn0QlV";
const MAX_BATCH_SIZE = 30;
const MAX_METADATA_CACHE_ITEMS = 5000;
const METADATA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const METADATA_CACHE_KEY = "videoMetadataById";
const ITEM_ID_PATTERN = /^[a-zA-Z0-9_:@.-]+$/;

async function signPath(path) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(PUBLIC_TOKEN),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(path));
  return [...new Uint8Array(signature)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeItemIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value).trim().toLocaleLowerCase())
    .filter((value) => ITEM_ID_PATTERN.test(value)))]
    .slice(0, MAX_BATCH_SIZE);
}

function sanitizeMetadata(value) {
  if (!value || !["genres", "tags", "actresses"].every((key) => Object.hasOwn(value, key))) {
    return null;
  }

  const rawDuration = value.duration;
  const duration = rawDuration === null || rawDuration === undefined || rawDuration === ""
    ? null
    : Number(rawDuration);
  const actresses = Array.isArray(value.actresses)
    ? value.actresses.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())
    : null;

  return {
    genres: Array.isArray(value.genres) ? value.genres.map(String) : null,
    tags: Array.isArray(value.tags) ? value.tags.map(String) : null,
    type: typeof value.type === "string" ? value.type : null,
    duration: Number.isFinite(duration) ? duration : null,
    actresses,
    cast: MissavActressLibrary.resolve(actresses)
  };
}

function isCompleteMetadata(metadata) {
  return metadata && Array.isArray(metadata.genres) && Array.isArray(metadata.tags) &&
    Array.isArray(metadata.actresses) && typeof metadata.type === "string" &&
    Number.isFinite(metadata.duration);
}

async function fetchMetadata(itemIds) {
  const ids = normalizeItemIds(itemIds);
  if (ids.length === 0) return {};

  const timestamp = Math.floor(Date.now() / 1000);
  const unsignedPath = `/${DATABASE_ID}/batch/?frontend_timestamp=${timestamp}`;
  const signature = await signPath(unsignedPath);
  const response = await fetch(
    `${API_HOST}${unsignedPath}&frontend_sign=${signature}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: ids.map((id) => ({
          method: "POST",
          path: "/search/users/anonymous/items/",
          params: {
            searchQuery: id,
            count: 10,
            returnProperties: true,
            includedProperties: ["genres", "tags", "type", "duration", "actresses"]
          }
        }))
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Metadata request failed with ${response.status}`);
  }

  const batch = await response.json();
  const result = {};

  for (let index = 0; index < ids.length; index += 1) {
    const entry = batch[index];
    // Do not turn a failed subrequest into a successful "record not found".
    // Missing keys are retried by the content script; explicit nulls are not.
    if (entry?.code !== 200 || !Array.isArray(entry.json?.recomms)) continue;
    const exact = entry.json.recomms.find((item) => item.id === ids[index]);
    if (!exact?.values) {
      result[ids[index]] = null;
      continue;
    }

    result[ids[index]] = sanitizeMetadata({
      genres: exact.values.genres ?? null,
      tags: exact.values.tags ?? null,
      type: exact.values.type ?? null,
      duration: exact.values.duration,
      actresses: Array.isArray(exact.values.actresses) ? exact.values.actresses : null
    });
  }

  return result;
}

let metadataCacheWrite = Promise.resolve();
let metadataCacheGeneration = 0;
let metadataCache = null;
let metadataCacheLoad = null;
const metadataInFlight = new Map();

function isFreshMetadata(record, now = Date.now()) {
  const timestamp = record?.cachedAt;
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now &&
    now - timestamp < METADATA_CACHE_TTL_MS && isCompleteMetadata(sanitizeMetadata(record));
}

function cacheObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function loadMetadataCache() {
  if (metadataCache !== null) return Promise.resolve(metadataCache);
  if (!metadataCacheLoad) {
    const load = chrome.storage.local.get({ [METADATA_CACHE_KEY]: {} }).then((stored) => {
      if (metadataCacheLoad === load) metadataCache = cacheObject(stored[METADATA_CACHE_KEY]);
      return metadataCache ?? cacheObject(stored[METADATA_CACHE_KEY]);
    }).catch((error) => {
      if (metadataCacheLoad === load) metadataCacheLoad = null;
      throw error;
    });
    metadataCacheLoad = load;
  }
  return metadataCacheLoad;
}

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[METADATA_CACHE_KEY]) return;
  metadataCache = cacheObject(changes[METADATA_CACHE_KEY].newValue);
  if (Object.keys(metadataCache).length === 0) {
    metadataCacheGeneration += 1;
    metadataInFlight.clear();
  }
  metadataCacheLoad = null;
});

function saveMetadataCache(metadataById, generation = metadataCacheGeneration) {
  const additions = Object.entries(metadataById)
    .map(([id, metadata]) => [id, sanitizeMetadata(metadata)])
    .filter(([, metadata]) => isCompleteMetadata(metadata));
  if (additions.length === 0) return Promise.resolve();

  metadataCacheWrite = metadataCacheWrite.catch(() => {}).then(async () => {
    if (generation !== metadataCacheGeneration) return;
    const current = await loadMetadataCache();
    if (generation !== metadataCacheGeneration) return;
    const cache = { ...current };
    const cachedAt = Date.now();

    for (const [id, metadata] of additions) {
      cache[id] = { ...metadata, cachedAt };
    }

    const retained = Object.entries(cache)
      .filter(([, record]) => isFreshMetadata(record, cachedAt))
      .sort((left, right) => Number(right[1].cachedAt ?? 0) - Number(left[1].cachedAt ?? 0))
      .slice(0, MAX_METADATA_CACHE_ITEMS);
    const prunedCache = Object.fromEntries(retained);
    await chrome.storage.local.set({
      [METADATA_CACHE_KEY]: prunedCache,
      metadataCacheCount: retained.length
    });
    // onChanged normally supplies the new snapshot. Retain it here as well
    // when that notification has not arrived yet; never overwrite a newer one.
    if (metadataCache === current) metadataCache = prunedCache;
  });

  return metadataCacheWrite;
}

async function queryMetadata(itemIds) {
  const ids = normalizeItemIds(itemIds);
  if (ids.length === 0) return {};

  const generation = metadataCacheGeneration;
  const cache = await loadMetadataCache();
  if (generation !== metadataCacheGeneration) return {};
  const metadataById = {};
  const missingIds = [];

  for (const id of ids) {
    const cached = sanitizeMetadata(cache?.[id]);
    if (isFreshMetadata(cache?.[id])) metadataById[id] = cached;
    else missingIds.push(id);
  }

  if (missingIds.length > 0) {
    const newIds = missingIds.filter((id) => !metadataInFlight.has(id));
    if (newIds.length > 0) {
      const pending = fetchMetadata(newIds).then(async (fetched) => {
        if (generation !== metadataCacheGeneration) return {};
        await saveMetadataCache(fetched, generation).catch(() => {});
        return generation === metadataCacheGeneration ? fetched : {};
      }).finally(() => {
        for (const id of newIds) if (metadataInFlight.get(id) === pending) metadataInFlight.delete(id);
      });
      for (const id of newIds) metadataInFlight.set(id, pending);
    }
    const fetchedPairs = await Promise.all(missingIds.map(async (id) => {
      const fetched = await metadataInFlight.get(id);
      return fetched && Object.hasOwn(fetched, id) ? [id, fetched[id]] : null;
    }));
    Object.assign(metadataById, Object.fromEntries(fetchedPairs.filter(Boolean)));
  }

  return generation === metadataCacheGeneration ? metadataById : {};
}

let discoveryWrite = Promise.resolve();

function saveDiscoveredTypes(metadataById, generation = metadataCacheGeneration) {
  const additions = Object.values(metadataById)
    .filter(Boolean)
    .flatMap((metadata) => [
      ...(metadata.genres ?? []),
      ...(metadata.tags ?? []),
      ...(metadata.type ? [metadata.type] : [])
    ])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (additions.length === 0) return;

  discoveryWrite = discoveryWrite.then(async () => {
    if (generation !== metadataCacheGeneration) return;
    const stored = await chrome.storage.local.get({ discoveredTypes: [] });
    if (generation !== metadataCacheGeneration) return;
    const byKey = new Map(
      [...stored.discoveredTypes, ...additions]
        .map((value) => [MissavGenreLibrary.normalize(value), String(value).trim()])
        .filter(([key]) => Boolean(key))
    );
    const nextTypes = [...byKey.values()]
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
      .slice(0, 500);
    if (
      nextTypes.length === stored.discoveredTypes.length &&
      nextTypes.every((value, index) => value === stored.discoveredTypes[index])
    ) {
      return;
    }
    await chrome.storage.local.set({ discoveredTypes: nextTypes });
  }).catch(() => {});
}

async function clearMetadataCache() {
  // Invalidate requests before waiting for the ordered writes. Responses already
  // in flight must not repopulate either the cache or discovered-category list.
  metadataCacheGeneration += 1;
  metadataInFlight.clear();
  metadataCache = {};
  metadataCacheLoad = null;
  await Promise.all([metadataCacheWrite.catch(() => {}), discoveryWrite.catch(() => {})]);
  await chrome.storage.local.set({
    [METADATA_CACHE_KEY]: {}, metadataCacheCount: 0, discoveredTypes: []
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "missav-clear-metadata-cache") {
    // The clear action is only available to our own extension popup, never a page.
    if (!chrome.runtime.id || sender.id !== chrome.runtime.id || sender.tab ||
        sender.url !== chrome.runtime.getURL("popup.html")) return false;
    void clearMetadataCache().then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: "缓存清除失败，请重试" }));
    return true;
  }
  if (message?.type !== "missav-query-metadata") return false;

  const senderUrl = sender.tab?.url ?? sender.url ?? "";
  try {
    const host = new URL(senderUrl).hostname;
    if (host !== "missav.ai" && !host.endsWith(".missav.ai")) return false;
  } catch {
    return false;
  }

  const generation = metadataCacheGeneration;
  void queryMetadata(message.itemIds)
    .then((items) => {
      saveDiscoveredTypes(items, generation);
      sendResponse({ ok: true, items });
    })
    .catch(() => sendResponse({ ok: false, items: {} }));
  return true;
});
