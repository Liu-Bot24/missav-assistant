const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['actress-data.js', 'actress-library.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const library = context.MissavActressLibrary;

test('同一演员五个中日文新旧名字仍只计一人', () => {
  const result = library.resolve(['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬']);
  assert.equal(result.confirmedCount, 1);
  assert.equal(result.names.length, 1);
  assert.equal(result.names[0], '田中柠檬');
  assert.equal(result.complete, true);
});

test('四位不同演员计四人，同一演员的多个名字不增加人数', () => {
  const result = library.resolve(['松本いちか', '松本一香', '深田えいみ', '天海こころ', '楓カレン', '田中レモン', 'MIRU', '坂道みる']);
  assert.equal(result.confirmedCount, 4);
  assert.equal(result.names.length, 4);
});

test('空数据、未知姓名、泛称和误认警告都不能制造额外演员', () => {
  assert.equal(library.resolve(null).confirmedCount, 0);
  assert.equal(library.resolve(['未知甲', '未知乙', '未知丙', '未知丁', '素人', '女優', 'SOD', 'いちか']).confirmedCount, 0);
  assert.equal(library.resolve(['松本いちか', 'いちか']).confirmedCount, 1);
  assert.equal(library.resolve(['松本いちか', 'いちか']).complete, false);
});

test('同名异人不被强行合并，缺少人物标识的名字不计入确定人数', () => {
  const resolve = library.createResolver({ records: [
    { id: 'person-a', name: '甲', aliases: ['演员甲', '同名'] },
    { id: 'person-b', name: '乙', aliases: ['演员乙', '同名'] },
    { id: 'person-a', name: '甲的旧中文名', aliases: ['旧名甲'] },
    { id: null, name: '丙', aliases: ['无身份名', '无身份旧名'] }
  ] });
  assert.equal(resolve(['同名', '无身份名']).confirmedCount, 0);
  assert.equal(resolve(['演员甲', '旧名甲']).confirmedCount, 1);
  assert.equal(resolve(['旧名甲']).names[0], '甲');
  assert.equal(resolve(['演员甲', '演员乙', '同名']).confirmedCount, 2);
  assert.equal(resolve(['无身份名', '无身份旧名']).names.length, 1);
});

test('姓名数据来自固定版本的 Amane，保留可核验的原始来源', () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/source.json'), 'utf8'));
  const xml = fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/mapping_actor.xml'));
  assert.equal(source.repository, 'https://github.com/sqzw-x/amane');
  assert.equal(context.MissavActressData.commit, source.commit);
  assert.equal(context.MissavActressData.sha256, crypto.createHash('sha256').update(xml).digest('hex'));
});

test('姓名只做精确规范化匹配，不用子串匹配猜身份', () => {
  assert.equal(library.resolve(['ＭＩＲＵ', 'miru', '坂道みる']).confirmedCount, 1);
  assert.equal(library.resolve(['松本いちか別人']).confirmedCount, 0);
});
