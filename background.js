"use strict";

importScripts("genre-library.js");

const DATABASE_ID = "missav-default";
const API_HOST = "https://client-rapi-missav.recombee.com";
const PUBLIC_TOKEN = "Ikkg568nlM51RHvldlPvc2GzZPE9R4XGzaH9Qj4zK9npbbbTly1gj9K4mgRn0QlV";
const MAX_BATCH_SIZE = 30;
const MAX_METADATA_CACHE_ITEMS = 5000;
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
  if (!value || !Array.isArray(value.genres) || !Array.isArray(value.tags)) {
    return null;
  }

  const rawDuration = value.duration;
  const duration = rawDuration === null || rawDuration === undefined || rawDuration === ""
    ? null
    : Number(rawDuration);

  return {
    genres: value.genres.map(String),
    tags: value.tags.map(String),
    type: typeof value.type === "string" ? value.type : "",
    duration: Number.isFinite(duration) ? duration : null
  };
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
            includedProperties: ["genres", "tags", "type", "duration"]
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
    const exact = entry?.code === 200
      ? entry.json?.recomms?.find((item) => item.id === ids[index])
      : null;
    if (!exact?.values) {
      result[ids[index]] = null;
      continue;
    }

    result[ids[index]] = {
      genres: Array.isArray(exact.values.genres) ? exact.values.genres : [],
      tags: Array.isArray(exact.values.tags) ? exact.values.tags : [],
      type: typeof exact.values.type === "string" ? exact.values.type : "",
      duration: Number.isFinite(Number(exact.values.duration))
        ? Number(exact.values.duration)
        : null
    };
  }

  return result;
}

let metadataCacheWrite = Promise.resolve();
let metadataCache = null;
let metadataCacheLoad = null;
const metadataInFlight = new Map();

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
  metadataCacheLoad = null;
});

function saveMetadataCache(metadataById) {
  const additions = Object.entries(metadataById)
    .map(([id, metadata]) => [id, sanitizeMetadata(metadata)])
    .filter(([, metadata]) => Boolean(metadata));
  if (additions.length === 0) return Promise.resolve();

  metadataCacheWrite = metadataCacheWrite.catch(() => {}).then(async () => {
    const current = await loadMetadataCache();
    const cache = { ...current };
    const cachedAt = Date.now();

    for (const [id, metadata] of additions) {
      cache[id] = { ...metadata, cachedAt };
    }

    const retained = Object.entries(cache)
      .filter(([, record]) => Boolean(sanitizeMetadata(record)))
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

  const cache = await loadMetadataCache();
  const metadataById = {};
  const missingIds = [];

  for (const id of ids) {
    const cached = sanitizeMetadata(cache?.[id]);
    if (cached) metadataById[id] = cached;
    else missingIds.push(id);
  }

  if (missingIds.length > 0) {
    const newIds = missingIds.filter((id) => !metadataInFlight.has(id));
    if (newIds.length > 0) {
      const pending = fetchMetadata(newIds).then(async (fetched) => {
        await saveMetadataCache(fetched).catch(() => {});
        return fetched;
      }).finally(() => {
        for (const id of newIds) metadataInFlight.delete(id);
      });
      for (const id of newIds) metadataInFlight.set(id, pending);
    }
    const fetchedPairs = await Promise.all(missingIds.map(async (id) => {
      const fetched = await metadataInFlight.get(id);
      return [id, fetched[id] ?? null];
    }));
    Object.assign(metadataById, Object.fromEntries(fetchedPairs));
  }

  return metadataById;
}

let discoveryWrite = Promise.resolve();

function saveDiscoveredTypes(metadataById) {
  const additions = Object.values(metadataById)
    .filter(Boolean)
    .flatMap((metadata) => [
      ...metadata.genres,
      ...metadata.tags,
      ...(metadata.type ? [metadata.type] : [])
    ])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (additions.length === 0) return;

  discoveryWrite = discoveryWrite.then(async () => {
    const stored = await chrome.storage.local.get({ discoveredTypes: [] });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "missav-query-metadata") return false;

  const senderUrl = sender.tab?.url ?? sender.url ?? "";
  try {
    const host = new URL(senderUrl).hostname;
    if (host !== "missav.ai" && !host.endsWith(".missav.ai")) return false;
  } catch {
    return false;
  }

  void queryMetadata(message.itemIds)
    .then((items) => {
      saveDiscoveredTypes(items);
      sendResponse({ ok: true, items });
    })
    .catch(() => sendResponse({ ok: false, items: {} }));
  return true;
});
