(() => {
  "use strict";

  const normalize = (value) => String(value ?? "").normalize("NFKC")
    .replace(/\s+/g, "").toLocaleLowerCase();

  // Card badge translations verified against all 13 site locales on 2026-09-05.
  // These describe the badge, not the language of the current page.
  const aliases = {
    uncensored: [
      "无码影片", "無碼影片", "無修正", "Uncensored", "일본노모",
      "Tidak ditapis", "ไม่เซ็นเซอร์", "Unzensiert", "Non censuré",
      "Không kiểm duyệt", "Tanpa sensor", "Hindi na-censor", "Sem censura"
    ],
    "chinese-subtitle": [
      "中文字幕", "中国語字幕", "Chinese subtitle", "Chinese subtitles", "중국어 자막",
      "Sari kata bahasa Cina", "คำบรรยายภาษาจีน", "chinesischer Untertitel",
      "Sous-titres chinois", "phụ đề tiếng trung", "subjudul Cina", "Legenda chinesa"
    ],
    "other-subtitle": [
      "英文字幕", "英語字幕", "English subtitle", "English subtitles", "영어 자막",
      "Sari kata bahasa Inggeris", "คำบรรยายภาษาอังกฤษ", "Englischer Untertitel",
      "Sous-titre anglais", "Phụ đề tiếng anh", "Subtitle bahasa inggris", "Legenda em inglês"
    ]
  };
  const byText = new Map(Object.entries(aliases).flatMap(([kind, labels]) =>
    labels.map((label) => [normalize(label), kind])
  ));

  function classifyText(text) {
    return byText.get(normalize(text)) ?? null;
  }

  function classifyCondition(condition) {
    // The site's badge predicate ends in its positive property. Earlier
    // subtitle fields can occur negated inside the uncensored predicate.
    // Inspect only that final term; never execute site-provided expressions.
    const field = String(condition ?? "").match(
      /(?:^|&&)\s*item\.(is_uncensored_leak|has_[a-z_]+_subtitles?)\s*$/i
    )?.[1]?.toLowerCase();
    if (!field) return null;
    if (field === "is_uncensored_leak") return "uncensored";
    return /^has_(?:chinese|zh|zh_cn|zh_tw|zh_hans|zh_hant)_subtitles?$/.test(field)
      ? "chinese-subtitle" : "other-subtitle";
  }

  function sanitizePresets(value) {
    const keys = Array.isArray(value) ? value : ["uncensored"];
    return [...new Set(keys.map((key) => key === "english-subtitle" ? "other-subtitle" : key)
      .filter((key) => Object.hasOwn(aliases, key)))];
  }

  globalThis.MissavLabelLibrary = Object.freeze({ classifyText, classifyCondition, sanitizePresets });
})();
