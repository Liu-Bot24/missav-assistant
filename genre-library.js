(() => {
  "use strict";

  const groups = Object.freeze([
    Object.freeze({
      id: "duration-4h-plus",
      label: "4 小时以上",
      description: "按影片时长判断（至少 4:00:00）",
      minDurationSeconds: 4 * 60 * 60,
      aliases: Object.freeze([])
    }),
    Object.freeze({
      id: "gender-diverse",
      label: "伪娘 / 变性 / 异装相关",
      description: "组合匹配站内多语言类型",
      aliases: Object.freeze([
        "人妖", "偽娘", "伪娘", "變性者", "变性者", "異裝男", "异装男",
        "女装・男の娘", "男の娘", "ニューハーフ", "shemale", "transsexual", "transgender"
      ])
    })
  ]);

  const seedTypes = Object.freeze([
    "3P・4P", "4K", "M女", "VR", "アナルセックス（男の娘）", "イラマチオ",
    "その他フェチ", "デビュー作品", "ニューハーフ", "ハーレム", "ハイビジョン",
    "中出し", "乱交", "制服", "単体作品", "女装・男の娘", "女子校生", "巨乳",
    "巨尻", "恋物癖", "監禁", "競泳・スクール水着", "素人", "美少女", "辱め",
    "顔射", "妄想族", "独占配信", "淫乱・ハード系",
    "高清", "獨家", "中出", "單體作品", "人妻", "熟女", "口交", "多人運動",
    "騎乘", "薄格", "痴女", "女高中生", "潮吹", "苗條", "自拍",
    "合集", "乳交", "美乳", "戀物癖", "NTR", "企劃", "亂倫", "搭訕", "顏射",
    "淫亂", "偷拍", "劇情", "自慰", "手淫", "姐姐", "羞辱"
  ]);

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim()
      .toLocaleLowerCase();
  }

  function groupRule(id) {
    return `group:${id}`;
  }

  function valueRule(value) {
    return `value:${encodeURIComponent(String(value))}`;
  }

  function decodeValueRule(rule) {
    if (!String(rule).startsWith("value:")) return null;
    try {
      return decodeURIComponent(String(rule).slice(6));
    } catch {
      return null;
    }
  }

  function normalizeRule(rule) {
    const text = String(rule);
    const value = decodeValueRule(text);
    if (value !== null) {
      const key = normalize(value);
      if (["4小時以上", "4小时以上", "4時間以上", "4時間以上作品"].includes(key)) {
        return groupRule("duration-4h-plus");
      }
      return valueRule(value);
    }

    if (text.startsWith("group:")) {
      return groups.some((group) => groupRule(group.id) === text) ? text : null;
    }

    return null;
  }

  function matches(rule, metadataValues, metadata = {}) {
    const normalizedRule = normalizeRule(rule);
    if (!normalizedRule) return false;

    const normalizedValues = (Array.isArray(metadataValues) ? metadataValues : [])
      .map(normalize)
      .filter(Boolean);
    const value = decodeValueRule(normalizedRule);
    if (value !== null) {
      const normalizedValue = normalize(value);
      return normalizedValues.some((item) => item === normalizedValue);
    }

    if (normalizedRule.startsWith("group:")) {
      const group = groups.find((item) => item.id === normalizedRule.slice(6));
      if (!group) return false;
      if (Number.isFinite(group.minDurationSeconds)) {
        return Number(metadata?.duration) >= group.minDurationSeconds;
      }
      return group.aliases
        .map(normalize)
        .some((alias) => normalizedValues.some((item) => item.includes(alias)));
    }

    return false;
  }

  function options(discoveredTypes = []) {
    const seen = new Set();
    const values = [...seedTypes, ...discoveredTypes]
      .map((value) => String(value).trim())
      .filter((value) => {
        const key = normalize(value);
        if (["4小時以上", "4小时以上", "4時間以上", "4時間以上作品"].includes(key)) {
          return false;
        }
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => left.localeCompare(right, "zh-CN"));

    return [
      ...groups.map((group) => ({
        rule: groupRule(group.id),
        label: group.label,
        description: group.description,
        kind: "group"
      })),
      ...values.map((value) => ({
        rule: valueRule(value),
        label: value,
        description: "站内类型",
        kind: "value"
      }))
    ];
  }

  globalThis.MissavGenreLibrary = Object.freeze({
    groups,
    seedTypes,
    normalize,
    groupRule,
    valueRule,
    decodeValueRule,
    normalizeRule,
    matches,
    options
  });
})();
