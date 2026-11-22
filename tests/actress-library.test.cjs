const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const context = vm.createContext({});
for (const file of ['text.js', 'actress-data.js', 'actress-library.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const library = context.ActressLibrary;

test('名录确认为同一人的多个名字只计一人', () => {
  const result = library.resolve(['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬']);
  assert.equal(result.count, 1);
  assert.equal(result.names.length, 1);
  assert.equal(result.names[0], '田中柠檬');
});

test('四位不同演员计四人，同一演员的多个名字不增加人数', () => {
  const result = library.resolve(['松本いちか', '松本一香', '深田えいみ', '天海こころ', '楓カレン', '田中レモン', 'MIRU', '坂道みる']);
  assert.equal(result.count, 4);
  assert.equal(result.names.length, 4);
});

test('名录里没有的名字也各算一人，并按原样显示', () => {
  const result = library.resolve(['未收录甲', '未收录乙', '未收录丙', '未收录丁']);
  assert.equal(result.count, 4);
  assert.deepEqual([...result.names], ['未收录甲', '未收录乙', '未收录丙', '未收录丁']);
  assert.equal(library.resolve(['松本いちか', '未收录甲']).count, 2);
  assert.equal(library.resolve(['松本いちか別人']).count, 1, '不用子串猜身份，但它仍是一个人');
});

test('空数据计零人，同一个名字重复出现只计一次', () => {
  assert.equal(library.resolve(null).count, 0);
  assert.equal(library.resolve([]).count, 0);
  assert.equal(library.resolve(['', '  ', 7]).count, 0);
  assert.equal(library.resolve(['未收录甲', ' 未收录甲 ', '未收录甲']).count, 1);
  assert.equal(library.resolve(['ＭＩＲＵ', 'miru', '坂道みる']).count, 1);
});

test('同名异人和身份不明的名字各算一人，不并到别人身上', () => {
  const resolve = library.createResolver({ records: [
    { id: 'person-a', name: '甲', aliases: ['演员甲', '同名'] },
    { id: 'person-b', name: '乙', aliases: ['演员乙', '同名'] },
    { id: 'person-a', name: '甲的旧中文名', aliases: ['旧名甲'] },
    { id: null, name: '丙', aliases: ['无身份名', '无身份旧名'] }
  ] });
  assert.equal(resolve(['同名', '无身份名']).count, 2);
  assert.equal(resolve(['演员甲', '旧名甲']).count, 1);
  assert.equal(resolve(['旧名甲']).names[0], '甲');
  assert.equal(resolve(['演员甲', '演员乙', '同名']).count, 3);
  assert.equal(resolve(['无身份名', '无身份旧名']).count, 1);
});

test('姓名数据来自固定版本的 Amane，保留可核验的原始来源', () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/source.json'), 'utf8'));
  const xml = fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/mapping_actor.xml'));
  assert.equal(source.repository, 'https://github.com/sqzw-x/amane');
  assert.equal(context.ActressData.commit, source.commit);
  assert.equal(context.ActressData.sha256, crypto.createHash('sha256').update(xml).digest('hex'));
});

test('“主名（别名、别名）”写法是一个人，括号里的名字用来认出是谁', () => {
  const result = library.resolve(['水咲ローラ（滝澤ローラ）', 'ミュウ（夏目ミュウ、春川リサ、夏目衣織）']);
  assert.equal(result.count, 2);
  const resolve = library.createResolver({ records: [
    { id: 'person-a', name: '甲', aliases: ['演员甲', '同名'] },
    { id: 'person-b', name: '乙', aliases: ['演员乙', '同名'] }
  ] });
  assert.equal(resolve(['未知（演员甲、演员乙）']).count, 1);
  assert.equal(resolve(['未知（同名）']).count, 1);
  assert.equal(resolve(['未知（演员甲、未收录）', '演员甲']).count, 1);
  assert.equal(resolve(['未知（演员甲、演员乙）', '演员甲']).count, 2);
  assert.equal(resolve(['完全未知（也未收录）']).count, 1);
});
