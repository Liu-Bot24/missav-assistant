const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "category-library.js"), "utf8");

function loadLibrary() {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "text.js"), "utf8"), context);
  vm.runInNewContext(source, context);
  return context.CategoryLibrary;
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

test("四小时以上按接口时长秒数判断，站内同名分类不单独列出", () => {
  const library = loadLibrary();
  const durationRule = library.groupRule("duration-4h-plus");
  const siteCategory = library.valueRule("4時間以上作品");

  assert.equal(library.matches(durationRule, [], { duration: 14438 }), true);
  assert.equal(library.matches(durationRule, [], { duration: 7279 }), false);
  assert.equal(
    library.options().some((option) =>
      option.rule === durationRule && option.label === "4 小时以上"
    ),
    true
  );
  assert.equal(
    library.options().some((option) => option.rule === siteCategory),
    false
  );
});

test("同一分类的不同写法共用一条规则", () => {
  const library = loadLibrary();
  const multi = library.valueRule("3P・4P");
  for (const value of ["3P・4P", "3P、4P", "3P/4P", "多人運動"]) assert.equal(library.matches(multi, [value]), true, value);
  for (const [rule, value] of [["ベスト・総集編", "ベスト、総集編"], ["寝取り・寝取られ・NTR", "寝取り・寝取られ"],
    ["若妻・幼妻", "若妻"], ["エステ", "エステ・マッサージ"]]) {
    assert.equal(library.matches(library.valueRule(rule), [value]), true, value);
    assert.equal(library.normalizeRule(library.valueRule(value)), library.valueRule(rule), "旧规则归到同一分类");
  }
  const labels = library.options(["3P、4P", "3P/4P", "ベスト、総集編"]).map((option) => option.label);
  assert.equal(labels.filter((label) => label === "多人运动").length, 1);
  assert.equal(labels.includes("最佳，综合"), false);
});

test("不同分类不会因为去掉标点而合并", () => {
  const library = loadLibrary();
  assert.equal(library.matches(library.valueRule("姉・妹"), ["姉"]), false);
  assert.equal(library.matches(library.valueRule("野外・露出"), ["露出"]), false);
});

test("中文名也能认出分类：旧规则与两种写法合为一项", () => {
  const library = loadLibrary();
  assert.equal(library.matches(library.valueRule("风俗"), ["風俗"]), true);
  assert.equal(library.normalizeRule(library.valueRule("风俗")), library.valueRule("風俗"));
  const values = library.options(["风俗", "風俗"]).filter((option) => option.kind === "value" && option.label === "风俗");
  assert.equal(values.length, 1);
});

test("分隔符只在识别已知分类时忽略，未知分类保留原样区分", () => {
  const library = loadLibrary();
  assert.equal(library.matches(library.valueRule("3P/4P"), ["3P・4P"]), true);
  assert.equal(library.matches(library.valueRule("1/2"), ["12"]), false);
  assert.notEqual(library.conceptKey("1/2"), library.conceptKey("12"));
});

test("见过的分类按出现次数排在前面，其余已知分类按名称排列", () => {
  const library = loadLibrary();
  const values = library.options(["中出し", "素人"]).filter((option) => option.kind === "value").map((option) => option.rule);
  assert.deepEqual(Array.from(values.slice(0, 2)), [library.valueRule("中出し"), library.valueRule("素人")]);
});
