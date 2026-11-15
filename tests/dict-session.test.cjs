const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let now = 0;
  const context = vm.createContext({ Date: { now: () => now } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/shared/dict-session.js'), 'utf8'), context);
  return { ...context, advance(ms) { now += ms; } };
}
const query = { word: 'bank', from: 'en', to: 'zh-CN', context: 'They sat on the river bank.', staged: true };
const response = () => ({ ok: true, result: { word: 'bank', translation: '岸', entries: [{ items: [{ definition: 'edge of a river' }] }] } });

test('returning to a pending word shares work and cached cards have independent mutable data', async () => {
  const h = harness();
  let resolve, calls = 0;
  const session = h.lmCreateDictSession(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = session.lookup(query), second = session.lookup({ ...query });
  assert.equal(calls, 1);
  resolve(response());
  const [a, b] = await Promise.all([first, second]);
  a.result.entries[0].items[0].definition = 'edited in an obsolete card';
  assert.equal(b.result.entries[0].items[0].definition, 'edge of a river');
  assert.equal(session.peek(query).result.entries[0].items[0].definition, 'edge of a river');
  await session.lookup(query);
  assert.equal(calls, 1);
});

test('context, language, phrase selection and Japanese reading separate lookup identities', async () => {
  let calls = 0;
  const session = harness().lmCreateDictSession(async () => { calls++; return response(); });
  for (const q of [query, { ...query, context: 'Deposit money in a bank.' }, { ...query, from: 'de' },
    { ...query, to: 'en' }, { ...query, isPhrase: true },
    { ...query, word: '人気', from: 'ja', japanese: { reading: 'にんき' } },
    { ...query, word: '人気', from: 'ja', japanese: { reading: 'ひとけ' } }]) await session.lookup(q);
  assert.equal(calls, 7);
});

test('failed or empty lookups can retry, successful entries expire and the LRU is bounded', async () => {
  const h = harness();
  let calls = 0;
  const session = h.lmCreateDictSession(async () => ++calls === 1 ? { ok: false, error: 'timeout' } : calls === 2 ? { ok: true, result: {} } : response());
  await session.lookup(query); assert.equal(session.peek(query), null);
  await session.lookup(query); assert.equal(session.peek(query), null);
  await session.lookup(query); assert.ok(session.peek(query));
  h.advance(300001); assert.equal(session.peek(query), null);
  await session.lookup(query); assert.equal(calls, 4);
  for (let index = 0; index < 79; index++) await session.lookup({ ...query, word: `word${index}` });
  assert.ok(session.peek(query));
  await session.lookup({ ...query, word: 'newest' });
  assert.ok(session.peek(query), 'recently read cards survive eviction');
  assert.equal(session.peek({ ...query, word: 'word0' }), null);
});

test('card growth keeps its anchor edge stable, stays in the viewport and recovers after layout moves', () => {
  const { lmPlaceDictionary } = harness();
  const card = { dataset: {}, style: {}, getBoundingClientRect: () => ({ width: 420 }) };
  let bounds = { left: 1000, top: 600, bottom: 620 };
  const anchor = { getBoundingClientRect: () => bounds };
  lmPlaceDictionary(card, anchor, { width: 1280, height: 900 });
  assert.equal(card.style.left, '852px');
  assert.equal(card.style.top, 'auto');
  assert.equal(card.style.bottom, '306px');
  card.getBoundingClientRect = () => ({ width: 420, height: 560 });
  lmPlaceDictionary(card, anchor, { width: 1280, height: 900 });
  assert.equal(card.style.bottom, '306px', 'expanded card stays above its word');
  bounds = { left: 40, top: 20, bottom: 40 };
  lmPlaceDictionary(card, anchor, { width: 1280, height: 900 });
  assert.equal(card.style.top, '46px');
  assert.equal(card.style.bottom, 'auto');
  assert.equal(card.style.maxHeight, '560px');
});
