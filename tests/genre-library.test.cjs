const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "genre-library.js"), "utf8");

function loadLibrary() {
  const context = {};
  vm.runInNewContext(source, context);
  return context.MissavGenreLibrary;
}

test("组合规则匹配站内多语言相关类型", () => {
  const library = loadLibrary();
  const rule = library.groupRule("gender-diverse");
  assert.equal(library.matches(rule, ["女装・男の娘"]), true);
  assert.equal(library.matches(rule, ["ニューハーフ"]), true);
  assert.equal(library.matches(rule, ["素人", "ハイビジョン"]), false);
});

test("精确类型规则不会误匹配相似分类", () => {
  const library = loadLibrary();
  const rule = library.valueRule("素人");
  assert.equal(library.matches(rule, ["素人"]), true);
  assert.equal(library.matches(rule, ["素人作品"]), false);
});

test("动态发现分类会去重并加入筛选库", () => {
  const library = loadLibrary();
  const options = library.options(["素人", "新分類", "新分類"]);
  assert.equal(options.filter((option) => option.label === "素人").length, 1);
  assert.equal(options.some((option) => option.label === "新分類"), true);
});

test("中文名称和旧日文规则对应同一类型，不误匹配相似名称", () => {
  const library = loadLibrary();
  const japanese = library.valueRule("ハイビジョン");
  const chinese = library.valueRule("高清");
  assert.equal(library.normalizeRule(chinese), japanese);
  assert.equal(library.matches(chinese, ["ハイビジョン"]), true);
  assert.equal(library.matches(japanese, ["高清"]), true);
  assert.equal(library.matches(chinese, ["4K"]), false);
  assert.equal(library.matches(chinese, ["高清修复"]), false);
  const options = library.options(["高清", "ハイビジョン", "獨家", "独家"]);
  assert.equal(options.filter(option => option.label === "高清").length, 1);
  assert.equal(options.filter(option => option.label === "独家").length, 1);
  assert.equal(options.some(option => /[\u3040-\u30ff]/u.test(option.label)), false);
  for (const option of options) {
    assert.equal(library.normalizeRule(library.normalizeRule(option.rule)), library.normalizeRule(option.rule));
  }
});

test("未收录的新类型保留原值，不猜测翻译或扩大匹配", () => {
  const library = loadLibrary();
  const value = "新分类-X";
  assert.equal(library.options([value]).some(option => option.label === value), true);
  assert.equal(library.matches(library.valueRule(value), [value]), true);
  assert.equal(library.matches(library.valueRule(value), ["新分类-X2"]), false);
});

test("四小时以上按接口时长秒数判断，并迁移旧文字规则", () => {
  const library = loadLibrary();
  const durationRule = library.groupRule("duration-4h-plus");
  const legacyRule = library.valueRule("4小時以上");

  assert.equal(library.normalizeRule(legacyRule), durationRule);
  assert.equal(library.matches(durationRule, [], { duration: 14438 }), true);
  assert.equal(library.matches(durationRule, [], { duration: 7279 }), false);
  assert.equal(
    library.options().some((option) =>
      option.rule === durationRule && option.label === "4 小时以上"
    ),
    true
  );
  assert.equal(
    library.options().some((option) => option.rule === legacyRule),
    false
  );
});
