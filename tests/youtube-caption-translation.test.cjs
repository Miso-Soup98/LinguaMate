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
  const code = source('src/content/youtube.js').replace('  else boot();', '  else boot();\n globalThis.fixture={state,parseEvents,alignCues,queueTranslation,currentIndex,installNativeTranslations};');
  vm.runInContext(code, context);
  return { ...context.fixture, requests, pending };
}
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('Japanese ASR normalizes word separators without merging playback timestamps', () => {
  const { parseEvents } = harness();
  const events = [
    { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: '台風 31 号 に 関する 最新 情報 を お伝えし' }] },
    { tStartMs: 4000, dDurationMs: 3000, segs: [{ utf8: 'ます。現在 の 台風 の 様子 を 気象 衛星' }] },
    { tStartMs: 7000, dDurationMs: 2500, segs: [{ utf8: 'ひまわり から 見て いきます。' }] }
  ];
  const cues = plain(parseEvents({ events }, { japanese: true, asr: true }));
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map(cue => cue.start), [1000, 4000, 7000]);
  assert.equal(cues.map(cue => cue.text).join(''), '台風31号に関する最新情報をお伝えします。現在の台風の様子を気象衛星ひまわりから見ていきます。');
  assert.equal(cues[0].start, 1000);
  assert.equal(cues[0].end, 4000);
  const latin = parseEvents({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'New York から 気象 衛星 を 見ます。' }] }] }, { japanese: true, asr: true });
  assert.equal(latin[0].text, 'New Yorkから気象衛星を見ます。');
  assert.match(parseEvents({ events }, { japanese: true, asr: false })[0].text, /台風 31 号/);
});

test('rolling ASR windows switch at the next cue rather than lag behind it', () => {
  const h = harness();
  const starts = [1800, 4000, 7000, 9400, 11200];
  h.state.cues = h.parseEvents({ events: starts.map((start, index) => ({
    tStartMs: start, dDurationMs: 10000, segs: [{ utf8: `字幕${index}` }]
  })) }, { japanese: true, asr: true });
  assert.equal(h.state.cues.length, starts.length);
  for (let i = 0; i < starts.length; i++) {
    assert.equal(h.currentIndex(starts[i]), i);
    if (i) assert.equal(h.currentIndex(starts[i] - 1), i - 1);
  }
  assert.equal(h.currentIndex(1799), -1);
  assert.equal(h.currentIndex(22000), -1);
  h.state.cues = [{ start: 0, end: 10000 }, { start: 3000, end: 6000 }];
  assert.equal(h.currentIndex(4000), 1, 'latest cue wins if an overlapping track reaches the renderer');
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

test('manual translation bypasses hidden preference and wins over background prefetch', async () => {
  const h = harness();
  h.state.directTranslation = true;
  h.state.cues = Array.from({length: 6}, (_, index) => ({start: index*1000,end:(index+1)*1000,text:`原文${index}`}));
  h.queueTranslation(0);h.queueTranslation(1);h.queueTranslation(2);h.queueTranslation(3);
  h.state.settings.showNative = false;
  h.queueTranslation(5, true);
  assert.equal(h.state.cues[5].translationRevealed, true);
  h.pending[0]({ok:true,result:{text:'first'}});await settle();
  assert.equal(h.requests[2].text, '原文5');
  assert.equal(h.requests[2].refresh, true);
});

test('platform translations are available for all rows and queued redundant work is skipped', async () => {
  const h = harness();
  h.state.directTranslation = true;
  h.state.cues = Array.from({length: 4}, (_, index) => ({start: index*1000,end:(index+1)*1000,text:`原文${index}`}));
  for(let i=0;i<4;i++)h.queueTranslation(i);
  h.installNativeTranslations(h.state.cues.map((cue,index)=>({...cue,text:`轨道译文${index}`})));
  assert.equal(h.state.nativeCues[3].text, '轨道译文3');
  h.pending[0]({ok:true,result:{text:'late automatic translation'}});
  h.pending[1]({ok:false});await settle();
  assert.equal(h.state.nativeCues[0].text, '轨道译文0');
  assert.equal(h.state.cues[1].translationError, false);
  assert.equal(h.requests.length, 2);
});

test('a delayed platform track cannot replace corrected or manually requested translations', () => {
  const h=harness();
  h.state.cues=[{start:0,end:1000,text:'corrected',originalText:'original'},
    {start:1000,end:2000,text:'manual',translationRevealed:true}];
  h.state.nativeCues=[{text:'corrected translation'},{text:'manual translation'}];
  h.installNativeTranslations([{start:0,end:2000,text:'old track'}]);
  assert.equal(h.state.nativeCues[0].text,'corrected translation');
  assert.equal(h.state.nativeCues[1].text,'manual translation');
});
