(() => {
  "use strict";

  const normalize = TextKey.normalize;

  // A name as written, apart from character width and surrounding spaces.
  const spellingOf = (value) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");

  function createResolver(data) {
    const ignored = new Set((data.ignoredAliases ?? []).map(normalize));
    const caution = new Set((data.cautionAliases ?? []).map(spellingOf));
    const byAlias = new Map();
    const identities = new Map();
    for (const [index, record] of data.records.entries()) {
      const key = record.id || `unverified:${index}`;
      if (!identities.has(key)) identities.set(key, record);
      for (const alias of record.aliases) {
        if (caution.has(spellingOf(alias))) continue;
        const normalized = normalize(alias);
        if (!normalized || ignored.has(normalized)) continue;
        if (!byAlias.has(normalized)) byAlias.set(normalized, new Map());
        byAlias.get(normalized).set(key, identities.get(key));
      }
    }

    const uniqueMatch = (candidates) => candidates?.size === 1 ? candidates.entries().next().value : null;
    // Spellings the source marks as confusable identify nobody, so they are not
    // folded into a similar unmarked alias by ignoring case or spacing.
    const lookup = (spelling) => caution.has(spelling) ? undefined : byAlias.get(normalize(spelling));

    // The site writes one person as "主名（别名、别名）". The bracketed names count
    // only when every recognized part points to the same person.
    function matchName(spelling) {
      const whole = lookup(spelling);
      if (whole) return uniqueMatch(whole);
      const parts = /^(.+?)\((.+)\)$/.exec(spelling);
      if (!parts) return null;
      const keys = new Map();
      for (const part of [parts[1], ...parts[2].split(/[、,，/]/)].map((value) => value.trim())) {
        const candidates = lookup(part);
        if (!candidates) continue;
        const match = uniqueMatch(candidates);
        if (!match) return null;
        keys.set(match[0], match);
      }
      return keys.size === 1 ? keys.values().next().value : null;
    }

    // Each entry in a video's cast list is one person, named in the library or not.
    // Entries merge only when the library places them on the same person: a
    // compilation may credit one actress under an earlier and a later name.
    // Names the library does not place merge only when written the same way.
    return (names) => {
      const people = new Map();
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== "string" || !name.trim()) continue;
        const spelling = spellingOf(name);
        const match = matchName(spelling);
        const key = match ? `person:${match[0]}` : `name:${spelling}`;
        if (!people.has(key)) people.set(key, match?.[1].name || name.trim());
      }
      return { count: people.size, names: [...people.values()] };
    };
  }

  globalThis.ActressLibrary = Object.freeze({
    normalize,
    createResolver,
    resolve: createResolver(globalThis.ActressData)
  });
})();
