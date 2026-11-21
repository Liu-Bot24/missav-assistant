"use strict";

importScripts("genre-library.js", "settings.js", "actress-data.js", "actress-library.js");

const DATABASE_ID = "missav-default";
const API_HOST = "https://client-rapi-missav.recombee.com";
const PUBLIC_TOKEN = "Ikkg568nlM51RHvldlPvc2GzZPE9R4XGzaH9Qj4zK9npbbbTly1gj9K4mgRn0QlV";
const MAX_BATCH_SIZE = 30;
const MAX_METADATA_CACHE_ITEMS = 5000;
// Pruning reads every record, so it runs once per this many additions, not per write.
const METADATA_CACHE_PRUNE_SLACK = 500;
// Each video is its own storage key, so a write touches only the videos it adds.
const METADATA_KEY_PREFIX = "md:";
const LEGACY_METADATA_CACHE_KEY = "videoMetadataById";
const ITEM_ID_PATTERN = /^[a-zA-Z0-9_:@.-]+$/;

chrome.runtime.onInstalled?.addListener(() => {
  MissavSettings.migrate();
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
      metadataCacheCount = (await listMetadataKeys()).length;
      await chrome.storage.local.set({ metadataCacheCount });
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
  await chrome.storage.local.set({ metadataCacheCount });
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
    await chrome.storage.local.set({
      ...Object.fromEntries(additions.map(([id, metadata]) => [metadataKey(id), storedRecord(metadata, cachedAt)])),
      metadataCacheCount: Math.min(metadataCacheCount, MAX_METADATA_CACHE_ITEMS)
    });
    if (metadataCacheCount > MAX_METADATA_CACHE_ITEMS + METADATA_CACHE_PRUNE_SLACK) await pruneMetadataCache();
  });

  return metadataCacheWrite;
}

async function queryMetadata(itemIds) {
  const ids = normalizeItemIds(itemIds);
  if (ids.length === 0) return {};

  await prepareMetadataCache();
  const stored = await chrome.storage.local.get(ids.map(metadataKey));
  const metadataById = {};
  const missingIds = [];
  const absentIds = new Set();

  for (const id of ids) {
    const record = stored[metadataKey(id)];
    if (record === undefined) absentIds.add(id);
    const cached = sanitizeMetadata(record);
    if (isCompleteMetadata(cached)) metadataById[id] = cached;
    else missingIds.push(id);
  }

  if (missingIds.length > 0) {
    const newIds = missingIds.filter((id) => !metadataInFlight.has(id));
    if (newIds.length > 0) {
      const pending = fetchMetadata(newIds).then(async (fetched) => {
        await saveMetadataCache(fetched, absentIds).catch(() => {});
        return fetched;
      }).finally(() => {
        for (const id of newIds) metadataInFlight.delete(id);
      });
      for (const id of newIds) metadataInFlight.set(id, pending);
    }
    const fetchedPairs = await Promise.all(missingIds.map(async (id) => {
      const fetched = await metadataInFlight.get(id);
      return Object.hasOwn(fetched, id) ? [id, fetched[id]] : null;
    }));
    Object.assign(metadataById, Object.fromEntries(fetchedPairs.filter(Boolean)));
  }

  return metadataById;
}

let discoveryWrite = Promise.resolve();

function saveDiscoveredTypes(metadataById) {
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
