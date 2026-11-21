"use strict";

importScripts("text.js", "site-library.js", "category-library.js", "settings.js", "actress-data.js", "actress-library.js");

const DATABASE_ID = "missav-default";
const API_HOST = "https://client-rapi-missav.recombee.com";
const PUBLIC_TOKEN = "Ikkg568nlM51RHvldlPvc2GzZPE9R4XGzaH9Qj4zK9npbbbTly1gj9K4mgRn0QlV";
const MAX_BATCH_SIZE = 30;
const MAX_METADATA_CACHE_ITEMS = 5000;
// Categories and casts on the site are corrected over time, so records are refreshed weekly.
const METADATA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Pruning reads every record, so it runs once per this many additions, not per write.
const METADATA_CACHE_PRUNE_SLACK = 500;
// Each video is its own storage key, so a write touches only the videos it adds.
const METADATA_KEY_PREFIX = "md:";
const LEGACY_METADATA_CACHE_KEY = "videoMetadataById";
const DISCOVERED_CATEGORIES_KEY = "discoveredCategories";
const LEGACY_DISCOVERED_KEY = "discoveredTypes";
// Earlier versions also stored the cache size; it is now kept in memory only.
const LEGACY_CACHE_COUNT_KEY = "metadataCacheCount";
// Counts are kept for many more categories than the picker offers, so a
// category that becomes common can still rise into it.
const MAX_DISCOVERED_CATEGORIES = 5000;
const ITEM_ID_PATTERN = /^[a-zA-Z0-9_:@.-]+$/;

chrome.runtime.onInstalled?.addListener(() => {
  SettingsStore.migrate();
  void prepareMetadataCache().catch(() => {});
});

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
    cast: ActressLibrary.resolve(actresses)
  };
}

function isFreshRecord(record, now) {
  const cachedAt = Number(record?.cachedAt);
  return Number.isFinite(cachedAt) && cachedAt > 0 && cachedAt <= now && now - cachedAt < METADATA_CACHE_TTL_MS;
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
            // The exact ID always ranks first; further results were downloaded and discarded.
            count: 1,
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
let metadataCachePrepared = null;
let metadataCacheCount = null;
const metadataInFlight = new Map();

const metadataKey = (id) => `${METADATA_KEY_PREFIX}${id}`;

// Only the site's own fields are stored; the cast summary is derived on every read.
function storedRecord(metadata, cachedAt) {
  const { genres, tags, type, duration, actresses } = metadata;
  return { genres, tags, type, duration, actresses, cachedAt };
}

async function listMetadataKeys() {
  const keys = typeof chrome.storage.local.getKeys === "function"
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  return keys.filter((key) => key.startsWith(METADATA_KEY_PREFIX));
}

// Moves the single-object cache of earlier versions to per-video keys, once.
async function migrateLegacyMetadataCache() {
  const stored = await chrome.storage.local.get(LEGACY_METADATA_CACHE_KEY);
  if (!Object.hasOwn(stored, LEGACY_METADATA_CACHE_KEY)) return;
  const legacy = stored[LEGACY_METADATA_CACHE_KEY];
  const records = Object.entries(legacy && typeof legacy === "object" ? legacy : {})
    .filter(([id]) => ITEM_ID_PATTERN.test(id))
    .map(([id, record]) => [id, sanitizeMetadata(record), Number(record?.cachedAt) || 0])
    .filter(([, metadata]) => isCompleteMetadata(metadata))
    .sort((left, right) => right[2] - left[2])
    .slice(0, MAX_METADATA_CACHE_ITEMS);
  if (records.length > 0) {
    await chrome.storage.local.set(Object.fromEntries(records.map(([id, metadata, cachedAt]) =>
      [metadataKey(id), storedRecord(metadata, cachedAt)])));
  }
  await chrome.storage.local.remove(LEGACY_METADATA_CACHE_KEY);
}

function prepareMetadataCache() {
  if (!metadataCachePrepared) {
    metadataCachePrepared = (async () => {
      await migrateLegacyMetadataCache();
      await migrateDiscoveredCategories();
      metadataCacheCount = (await listMetadataKeys()).length;
      await chrome.storage.local.remove(LEGACY_CACHE_COUNT_KEY);
    })().catch((error) => {
      metadataCachePrepared = null;
      throw error;
    });
  }
  return metadataCachePrepared;
}

async function pruneMetadataCache() {
  const keys = await listMetadataKeys();
  if (keys.length > MAX_METADATA_CACHE_ITEMS) {
    const records = await chrome.storage.local.get(keys);
    const expired = keys
      .sort((left, right) => Number(records[right]?.cachedAt ?? 0) - Number(records[left]?.cachedAt ?? 0))
      .slice(MAX_METADATA_CACHE_ITEMS);
    await chrome.storage.local.remove(expired);
  }
  metadataCacheCount = Math.min(keys.length, MAX_METADATA_CACHE_ITEMS);
}

function saveMetadataCache(metadataById, absentIds) {
  const additions = Object.entries(metadataById)
    .map(([id, metadata]) => [id, sanitizeMetadata(metadata)])
    .filter(([, metadata]) => isCompleteMetadata(metadata));
  if (additions.length === 0) return Promise.resolve();

  metadataCacheWrite = metadataCacheWrite.catch(() => {}).then(async () => {
    await prepareMetadataCache();
    const cachedAt = Date.now();
    metadataCacheCount += additions.filter(([id]) => absentIds.has(id)).length;
    await chrome.storage.local.set(
      Object.fromEntries(additions.map(([id, metadata]) => [metadataKey(id), storedRecord(metadata, cachedAt)])));
    if (metadataCacheCount > MAX_METADATA_CACHE_ITEMS + METADATA_CACHE_PRUNE_SLACK) await pruneMetadataCache();
  });

  return metadataCacheWrite;
}

function forgetMetadata(ids) {
  metadataCacheWrite = metadataCacheWrite.catch(() => {}).then(async () => {
    await prepareMetadataCache();
    await chrome.storage.local.remove(ids.map(metadataKey));
    metadataCacheCount = Math.max(0, metadataCacheCount - ids.length);
  });
  return metadataCacheWrite;
}

async function queryMetadata(itemIds) {
  const ids = normalizeItemIds(itemIds);
  if (ids.length === 0) return {};

  await prepareMetadataCache();
  const stored = await chrome.storage.local.get(ids.map(metadataKey));
  const now = Date.now();
  const metadataById = {};
  const missingIds = [];
  const absentIds = new Set();
  const staleById = {};

  for (const id of ids) {
    const record = stored[metadataKey(id)];
    if (record === undefined) absentIds.add(id);
    const cached = sanitizeMetadata(record);
    if (!isCompleteMetadata(cached)) {
      missingIds.push(id);
    } else if (isFreshRecord(record, now)) {
      metadataById[id] = cached;
    } else {
      staleById[id] = cached;
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    const newIds = missingIds.filter((id) => !metadataInFlight.has(id));
    if (newIds.length > 0) {
      // A failed refresh leaves the IDs out; stale records then still answer.
      const pending = fetchMetadata(newIds).catch(() => ({})).then(async (fetched) => {
        await saveMetadataCache(fetched, absentIds).catch(() => {});
        // The service no longer has these videos; their old records go.
        const withdrawn = newIds.filter((id) => fetched[id] === null && !absentIds.has(id));
        if (withdrawn.length > 0) await forgetMetadata(withdrawn).catch(() => {});
        // A video counts toward the category list once, when it is first cached.
        const added = Object.fromEntries(Object.entries(fetched).filter(([id]) => absentIds.has(id)));
        await recordCategories(added).catch(() => {});
        return fetched;
      }).finally(() => {
        for (const id of newIds) metadataInFlight.delete(id);
      });
      for (const id of newIds) metadataInFlight.set(id, pending);
    }
    const fetchedPairs = await Promise.all(missingIds.map(async (id) => {
      const fetched = await metadataInFlight.get(id);
      if (!Object.hasOwn(fetched, id)) return staleById[id] ? [id, staleById[id]] : null;
      // An incomplete answer does not replace complete older data.
      if (fetched[id] !== null && !isCompleteMetadata(fetched[id]) && staleById[id]) return [id, staleById[id]];
      return [id, fetched[id]];
    }));
    Object.assign(metadataById, Object.fromEntries(fetchedPairs.filter(Boolean)));
  }

  return metadataById;
}

let discoveryWrite = Promise.resolve();

// Categories for the picker: genres and tags only. The type field holds the
// site's catalogue names and uploader codes, which are not categories.
function categoryValues(metadata) {
  return [...(metadata?.genres ?? []), ...(metadata?.tags ?? [])]
    .map((value) => String(value).trim())
    .filter(Boolean);
}

// Counts how many videos carry each category, one per video and spelling-independent.
function countCategories(counts, metadataList) {
  const byKey = new Map(Object.entries(counts).map(([value, count]) =>
    [CategoryLibrary.conceptKey(value), [value, count]]));
  for (const metadata of metadataList) {
    const seen = new Set();
    for (const value of categoryValues(metadata)) {
      const key = CategoryLibrary.conceptKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const [stored, count] = byKey.get(key) ?? [CategoryLibrary.canonicalValue(value), 0];
      byKey.set(key, [stored, count + 1]);
    }
  }
  // When full, the rarest categories make room; ties keep the alphabetical first.
  return Object.fromEntries([...byKey.values()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"))
    .slice(0, MAX_DISCOVERED_CATEGORIES));
}

async function readCategoryCounts() {
  const stored = await chrome.storage.local.get(DISCOVERED_CATEGORIES_KEY);
  const counts = stored[DISCOVERED_CATEGORIES_KEY];
  return counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {};
}

// Earlier versions kept an alphabetical list that mixed in type values.
// The cached videos rebuild it with counts, once.
async function migrateDiscoveredCategories() {
  const stored = await chrome.storage.local.get([DISCOVERED_CATEGORIES_KEY, LEGACY_DISCOVERED_KEY]);
  if (Object.hasOwn(stored, DISCOVERED_CATEGORIES_KEY)) return;
  const keys = await listMetadataKeys();
  const records = keys.length > 0 ? Object.values(await chrome.storage.local.get(keys)) : [];
  await chrome.storage.local.set({ [DISCOVERED_CATEGORIES_KEY]: countCategories({}, records) });
  if (Object.hasOwn(stored, LEGACY_DISCOVERED_KEY)) await chrome.storage.local.remove(LEGACY_DISCOVERED_KEY);
}

function recordCategories(metadataById) {
  const fetched = Object.values(metadataById).filter(Boolean);
  if (!fetched.some((metadata) => categoryValues(metadata).length > 0)) return Promise.resolve();
  discoveryWrite = discoveryWrite.catch(() => {}).then(async () => {
    await prepareMetadataCache();
    const counts = countCategories(await readCategoryCounts(), fetched);
    await chrome.storage.local.set({ [DISCOVERED_CATEGORIES_KEY]: counts });
  });
  return discoveryWrite;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "viewing-assistant-query-metadata") return false;

  const senderUrl = sender.tab?.url ?? sender.url ?? "";
  try {
    const host = new URL(senderUrl).hostname;
    if (!SiteLibrary.isMetadataHost(host)) return false;
  } catch {
    return false;
  }

  void queryMetadata(message.itemIds)
    .then((items) => sendResponse({ ok: true, items }))
    .catch(() => sendResponse({ ok: false, items: {} }));
  return true;
});
