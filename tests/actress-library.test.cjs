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

test('列出的每个名字算一人，名录认得出的名字显示名录里的中文名', () => {
  const result = library.resolve(['田中レモン', '松本いちか', '深田えいみ']);
  assert.equal(result.count, 3);
  assert.deepEqual([...result.names], ['田中柠檬', '松本一香', library.resolve(['深田えいみ']).names[0]]);
});

test('名录认为是同一人的不同名字也各算一人，显示只列一次', () => {
  const result = library.resolve(['楓カレン', '枫可怜', '枫花恋', '田中レモン', '田中柠檬']);
  assert.equal(result.count, 5);
  assert.deepEqual([...result.names], ['田中柠檬']);
  assert.equal(library.resolve(['管野しずか', '神納花']).count, 2);
});

test('名录里没有的名字也各算一人，并按原样显示', () => {
  const result = library.resolve(['未收录甲', '未收录乙', '未收录丙', '未收录丁']);
  assert.equal(result.count, 4);
  assert.deepEqual([...result.names], ['未收录甲', '未收录乙', '未收录丙', '未收录丁']);
});

test('空数据计零人；同一写法重复列出只算一次，大小写和空格不同就是不同的名字', () => {
  assert.equal(library.resolve(null).count, 0);
  assert.equal(library.resolve([]).count, 0);
  assert.equal(library.resolve(['', '  ', 7]).count, 0);
  assert.equal(library.resolve(['未收录甲', ' 未收录甲 ', '未收录甲']).count, 1);
  assert.equal(library.resolve(['Ｌｉｎａ', 'Lina']).count, 1, '只有全角半角之差的是同一写法');
  assert.deepEqual([...library.resolve(['Ｌｉｎａ', 'Lina']).names], ['Ｌｉｎａ'], '显示第一次出现的原写法');
  assert.equal(library.resolve(['Lina', 'Li Na', 'lina']).count, 3);
});

test('“主名（别名、别名）”是一个名字，算一人；括号里的名字用来认出显示名', () => {
  const result = library.resolve(['水咲ローラ（滝澤ローラ）', 'ミュウ（夏目ミュウ、春川リサ、夏目衣織）']);
  assert.equal(result.count, 2);
  const resolve = library.createResolver({ records: [
    { id: 'person-a', name: '甲', aliases: ['演员甲', '同名'] },
    { id: 'person-b', name: '乙', aliases: ['演员乙', '同名'] }
  ] });
  assert.deepEqual([...resolve(['未知（演员甲、未收录）']).names], ['甲']);
  assert.deepEqual([...resolve(['未知（演员甲、演员乙）']).names], ['未知（演员甲、演员乙）']);
  assert.deepEqual([...resolve(['同名']).names], ['同名'], '同名异人不显示成其中任何一人');
});

test('来源标为易误认或同名异人的写法不显示成任何人', () => {
  const caution = context.ActressData.cautionAliases;
  assert.ok(caution.includes('RENA') && caution.includes('平原みなみ') && caution.includes('CHIYU'));
  assert.equal(caution.includes('尾上涼子'), false);
  assert.deepEqual([...library.resolve(['RENA']).names], ['RENA']);
  assert.deepEqual([...library.resolve(['Rena']).names], [library.resolve(['衣吹かのん']).names[0]], '未标注的写法仍认得出');
  assert.deepEqual([...library.resolve(['Chiyu']).names], ['Chiyu']);
  const resolve = library.createResolver({ cautionAliases: ['ABC'], records: [
    { id: 'person-a', name: '甲', aliases: ['演员甲', 'Abc', 'XYZ'] }
  ] });
  assert.deepEqual([...resolve(['ABC']).names], ['ABC']);
  assert.deepEqual([...resolve(['abc']).names], ['甲']);
});

test('姓名数据来自固定版本的 Amane，保留可核验的原始来源', () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/source.json'), 'utf8'));
  const xml = fs.readFileSync(path.join(__dirname, '..', 'third-party/amane/mapping_actor.xml'));
  assert.equal(source.repository, 'https://github.com/sqzw-x/amane');
  assert.equal(context.ActressData.commit, source.commit);
  assert.equal(context.ActressData.sha256, crypto.createHash('sha256').update(xml).digest('hex'));
});
