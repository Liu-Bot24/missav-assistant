(() => {
  "use strict";

  // Owns lookup state only. Consumers decide how records affect filters or UI.
  function create({ query, batchSize = 30, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    const records = new Map();
    const queued = new Set();
    const listeners = new Set();
    const idle = Object.freeze({ status: "idle", data: null });
    let flushScheduled = false;

    function publish(ids) {
      if (ids.length === 0) return;
      for (const listener of listeners) listener(ids);
    }

    function finish(record, status, data = null) {
      record.value = Object.freeze({ status, data });
      record.resolve(record.value);
    }

    async function fetchBatch(batch) {
      let remaining = batch;
      for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt += 1) {
        if (attempt > 0) await delay(attempt * 1000);
        let items;
        try { items = await query(remaining.map((record) => record.id)); }
        catch { items = {}; }
        const changed = [];
        const failed = [];
        for (const record of remaining) {
          if (items && Object.hasOwn(items, record.id)) {
            const data = items[record.id];
            finish(record, data ? "ready" : "missing", data ?? null);
            changed.push(record.id);
          } else {
            failed.push(record);
          }
        }
        // A successful item is available now, independently of other retries.
        remaining = failed;
        publish(changed);
      }
      for (const record of remaining) finish(record, "error");
      publish(remaining.map((record) => record.id));
    }

    function flush() {
      flushScheduled = false;
      const batch = [...queued];
      queued.clear();
      for (let offset = 0; offset < batch.length; offset += batchSize) {
        void fetchBatch(batch.slice(offset, offset + batchSize));
      }
    }

    function request(ids) {
      for (const id of new Set(ids.filter(Boolean))) {
        if (records.has(id)) continue;
        const record = { id, value: Object.freeze({ status: "pending", data: null }) };
        record.promise = new Promise((resolve) => { record.resolve = resolve; });
        records.set(id, record);
        queued.add(record);
      }
      if (queued.size > 0 && !flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    }

    function retry(ids) {
      const changed = [];
      for (const id of new Set(ids.filter(Boolean))) {
        if (records.get(id)?.value.status === "pending") continue;
        records.delete(id);
        changed.push(id);
      }
      request(changed);
      publish(changed);
    }

    return Object.freeze({
      get: (id) => records.get(id)?.value ?? idle,
      request,
      async settled(ids) {
        request(ids);
        return Promise.all([...new Set(ids.filter(Boolean))].map((id) => records.get(id).promise));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retry,
      invalidateUnresolved() {
        const changed = [];
        for (const [id, record] of records) {
          if (!["error", "missing"].includes(record.value.status)) continue;
          records.delete(id);
          changed.push(id);
        }
        publish(changed);
      }
    });
  }

  globalThis.MissavMetadataClient = Object.freeze({ create });
})();
