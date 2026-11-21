(() => {
  "use strict";

  const normalize = TextKey.normalize;

  function createResolver(data) {
    const ignored = new Set((data.ignoredAliases ?? []).map(normalize));
    const byAlias = new Map();
    const identities = new Map();
    for (const [index, record] of data.records.entries()) {
      const key = record.id || `unverified:${index}`;
      if (!identities.has(key)) identities.set(key, record);
      for (const alias of record.aliases) {
        const normalized = normalize(alias);
        if (!normalized || ignored.has(normalized)) continue;
        if (!byAlias.has(normalized)) byAlias.set(normalized, new Map());
        byAlias.get(normalized).set(key, identities.get(key));
      }
    }

    const uniqueMatch = (candidates) => candidates?.size === 1 ? candidates.entries().next().value : null;

    // The site writes one person as "主名（别名、别名）". The bracketed names count
    // only when every recognized part points to the same person.
    function matchName(normalized) {
      const whole = byAlias.get(normalized);
      if (whole) return uniqueMatch(whole);
      const parts = /^(.+?)\((.+)\)$/.exec(normalized);
      if (!parts) return null;
      const keys = new Map();
      for (const part of [parts[1], ...parts[2].split(/[、,，/]/)]) {
        const candidates = byAlias.get(part);
        if (!candidates) continue;
        const match = uniqueMatch(candidates);
        if (!match) return null;
        keys.set(match[0], match);
      }
      return keys.size === 1 ? keys.values().next().value : null;
    }

    return (names) => {
      const people = new Map();
      const unresolved = new Map();
      const display = new Map();
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== "string" || !name.trim()) continue;
        const normalized = normalize(name);
        const match = matchName(normalized);
        const person = match?.[1];
        if (person?.id) {
          if (!people.has(person.id)) people.set(person.id, { id: person.id, name: person.name });
          if (!display.has(person.id)) display.set(person.id, person.name);
        } else {
          // Unmapped, shared and unverified names are not evidence of an extra person.
          // Never use the API's name count or invent a person ID from a raw name.
          if (!unresolved.has(normalized)) unresolved.set(normalized, name.trim());
          const label = person?.name || name.trim();
          const displayKey = match?.[0] ?? `unresolved:${normalized}`;
          if (!display.has(displayKey)) display.set(displayKey, label);
        }
      }
      return {
        people: [...people.values()],
        confirmedCount: people.size,
        names: [...display.values()],
        unresolved: [...unresolved.values()],
        complete: Array.isArray(names) && unresolved.size === 0
      };
    };
  }

  globalThis.ActressLibrary = Object.freeze({
    normalize,
    createResolver,
    resolve: createResolver(globalThis.ActressData)
  });
})();
