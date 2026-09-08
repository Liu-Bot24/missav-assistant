const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'metadata-client.js'), 'utf8');
const tick = () => new Promise(setImmediate);
function create(query, delay = async () => {}) {
  const context = { queueMicrotask, setTimeout };
  vm.runInNewContext(source, context);
  return context.MissavMetadataClient.create({ query, delay });
}

test('65 个未缓存影片合并为 30/30/5，慢批次不阻塞已返回批次', async () => {
  const calls = [];
  let releaseSlow;
  const client = create(async ids => {
    calls.push([...ids]);
    if (ids.includes('item-30')) await new Promise(resolve => { releaseSlow = resolve; });
    return Object.fromEntries(ids.map(id => [id, { genres: ['keep'], actresses: ['sample'] }]));
  });
  const ids = Array.from({ length: 65 }, (_, index) => `item-${index}`);
  client.request(ids);
  client.request(ids.slice(0, 40));
  await tick();
  assert.deepEqual(calls.map(ids => ids.length), [30, 30, 5]);
  assert.equal(client.get('item-0').status, 'ready');
  assert.equal(client.get('item-64').status, 'ready');
  assert.equal(client.get('item-30').status, 'pending');
  releaseSlow();
  await client.settled(ids);
  await client.settled(ids);
  assert.equal(calls.length, 3, '判定和姓名读取同一结果，不重复获取');
});

test('同批部分成功立即可用，重试只包含失败项，明确无记录不会自动重试', async () => {
  const calls = [];
  let releaseRetry;
  const client = create(async ids => {
    calls.push([...ids]);
    return calls.length === 1 ? { fast: { genres: ['keep'] }, missing: null } : { slow: { genres: ['blocked'] } };
  }, () => new Promise(resolve => { releaseRetry = resolve; }));
  client.request(['fast', 'slow', 'missing']);
  await tick();
  assert.equal(client.get('fast').status, 'ready');
  assert.equal(client.get('missing').status, 'missing');
  assert.equal(client.get('slow').status, 'pending');
  releaseRetry();
  await client.settled(['fast', 'slow', 'missing']);
  assert.deepEqual(calls, [['fast', 'slow', 'missing'], ['slow']]);
});

test('请求失败最多三次，错误与不存在记录分开；恢复时不重查成功数据', async () => {
  let calls = 0;
  let offline = true;
  const client = create(async ids => {
    calls++;
    if (offline) throw new Error('offline');
    return Object.fromEntries(ids.map(id => [id, { genres: [] }]));
  });
  await client.settled(['a']);
  assert.equal(calls, 3);
  assert.equal(client.get('a').status, 'error');
  client.invalidateUnresolved();
  await tick();
  assert.equal(calls, 3, '失效不等于发送请求，只有当前需要的卡片才重新获取');
  offline = false;
  await client.settled(['a']);
  assert.equal(client.get('a').status, 'ready');
  client.invalidateUnresolved();
  await client.settled(['a']);
  assert.equal(calls, 4);
});
