const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

function harness() {
  const requests = [];
  const pending = [];
  const context = vm.createContext({
    window: { addEventListener() {} }, document: { addEventListener() {}, readyState: 'loading' },
    chrome: { storage: { onChanged: { addListener() {} } } }, setInterval() {},
    lmMergeSettings: () => ({ enabled: true, showNative: true, learningLang: 'ja', nativeLang: 'zh-CN' }),
    lmSendMessage: (type, message) => { requests.push({ type, ...message }); return new Promise(resolve => pending.push(resolve)); }
  });
  const code = source('src/content/youtube.js').replace('  else boot();', '  else boot();\n globalThis.fixture={state,parseEvents,alignCues,queueTranslation};');
  vm.runInContext(code, context);
  return { ...context.fixture, requests, pending };
}
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('Japanese ASR separators and line wraps do not split lexical or auxiliary words', () => {
  const { parseEvents } = harness();
  const events = [
    { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: '台風 31 号 に 関する 最新 情報 を お伝えし' }] },
    { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: 'ます。現在 の 台風 の 様子 を 気象 衛星' }] },
    { tStartMs: 7000, dDurationMs: 2500, segs: [{ utf8: 'ひまわり から 見て いきます。' }] }
  ];
  const cues = plain(parseEvents({ events }, { japanese: true, asr: true }));
  assert.equal(cues[0].text, '台風31号に関する最新情報をお伝えします。現在の台風の様子を気象衛星ひまわりから見ていきます。');
  assert.equal(cues[0].start, 1000);
  assert.equal(cues[0].end, 9500);
  const latin = parseEvents({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'New York から 気象 衛星 を 見ます。' }] }] }, { japanese: true, asr: true });
  assert.equal(latin[0].text, 'New Yorkから気象衛星を見ます。');
  assert.match(parseEvents({ events }, { japanese: true, asr: false })[0].text, /台風 31 号/);
});

test('translation alignment keeps every overlapping sentence instead of only the midpoint', () => {
  const { alignCues } = harness();
  const original = [{ start: 1000, end: 12000, text: 'long Japanese caption' }, { start: 20000, end: 23000, text: 'gap' }];
  const translated = [
    { start: 1000, end: 4000, text: '播报台风最新消息。' },
    { start: 4000, end: 7000, text: '现在来看台风的情况。' },
    { start: 7000, end: 9500, text: '通过气象卫星观察。' },
    { start: 9500, end: 12000, text: '这是31号台风。' },
    { start: 30000, end: 34000, text: '不相关的字幕。' }
  ];
  const aligned = plain(alignCues(original, translated));
  assert.equal(aligned[0].text, translated.slice(0, 4).map(c => c.text).join(' '));
  assert.equal(aligned[1].text, '');
});

test('translation queue caps requests, deduplicates and ignores a previous language generation', async () => {
  const h = harness();
  h.state.directTranslation = true;
  h.state.cues = Array.from({ length: 6 }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, text: `原文${i}。` }));
  for (let i = 0; i < 6; i++) { h.queueTranslation(i); h.queueTranslation(i); }
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].text, '原文0。');
  h.pending[0]({ ok: true, result: { text: '完整译文0。' } });
  await settle();
  assert.equal(h.state.nativeCues[0].text, '完整译文0。');
  assert.equal(h.requests.length, 3);
  h.state.loadGen++;
  h.state.nativeCues = [];
  h.pending[1]({ ok: true, result: { text: 'stale' } });
  h.pending[2]({ ok: true, result: { text: 'stale' } });
  await settle();
  assert.equal(h.state.nativeCues.length, 0);
  assert.equal(h.requests.length, 3, 'stale queued work is discarded before sending');
});

test('failed translation does not loop and explicit retry can recover', async () => {
  const h = harness();
  h.state.directTranslation = true;
  h.state.cues = [{ start: 0, end: 1000, text: '雨です。' }];
  h.queueTranslation(0);
  h.pending[0]({ ok: false });await settle();
  assert.equal(h.state.cues[0].translationError, true);
  h.queueTranslation(0);assert.equal(h.requests.length, 1);
  h.queueTranslation(0, true);assert.equal(h.requests.length, 2);
  h.pending[1]({ ok: true, result: { text: '下雨了。' } });await settle();
  assert.equal(h.state.nativeCues[0].text, '下雨了。');
  assert.equal(h.state.cues[0].translationError, false);
});
