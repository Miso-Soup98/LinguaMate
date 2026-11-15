const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/content/youtube.js'), 'utf8').replace(/\r\n/g, '\n');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const trackText = (text = 'first caption') => JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: text }] }] });

function harness() {
  const requests = [], counts = { panels: 0, current: 0, hidden: 0, observed: 0, updated: [], queued: [] };
  const timers = new Map(), listeners = new Map();
  const location = { href: 'https://www.youtube.com/watch?v=alpha' };
  let serial = 0, handler;
  handler = async (type, data) => {
    if (type === 'LM_PING') return { ok: true };
    if (type === 'LM_GET_TRACKS') return { videoId: new URL(location.href).searchParams.get('v'), tracks: [{ languageCode: 'ja', baseUrl: 'https://example.test/ja', kind: 'asr' }] };
    if (type === 'LM_FETCH_TRACK') return { text: trackText(data.tlang ? '译文' : 'first caption') };
  };
  const window = { addEventListener(type, callback) { listeners.set(type, callback); } };
  const context = vm.createContext({ URL, location, window,
    document: { title: 'Fixture - YouTube', readyState: 'loading', addEventListener() {} },
    chrome: { storage: { onChanged: { addListener() {} } } }, setInterval() {},
    setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    lmMergeSettings: () => ({ enabled: true, showNative: true, learningLang: 'ja', nativeLang: 'zh-CN' }),
    lmYtCode: lang => lang === 'zh-CN' ? 'zh-Hans' : lang,
    fixturePage: async (...args) => { requests.push({ type: args[0], data: args[1] }); return handler(...args); },
    counts
  });
  const expose = `
    requestPage = fixturePage;
    sleep = async () => {};
    renderPanel = () => { counts.panels++; };
    renderCurrent = () => { counts.current++; state.activeIndex = state.cues.length ? 0 : -1; };
    hideDict = () => { counts.hidden++; };
    invalidateJapaneseLines = () => {};
    updateTranslationLine = index => { counts.updated.push(index); };
    observeVisibleTranslations = () => { counts.observed++; };
    queueTranslation = index => { counts.queued.push(index); };
    mountUi = () => {};
    hasBooted = true;
    globalThis.fixture = { state, loadCaptions, retryCaptions, captionCache };
  `;
  vm.runInContext(source.replace('  else boot();', `  else boot();\n${expose}`), context);
  return { ...context.fixture, requests, counts, location, timers,
    handler(value) { handler = value; },
    signal(type, videoId) { listeners.get('message')({ source: window, data: { source: 'linguamate-page', type, videoId } }); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }
  };
}

test('duplicate navigation and CC signals share one load and translation completion preserves source render', async () => {
  const h = harness(), original = deferred(), translated = deferred();
  h.handler(async (type, data) => type === 'LM_PING' ? { ok: true } : type === 'LM_GET_TRACKS'
    ? { videoId: 'alpha', tracks: [{ languageCode: 'ja', baseUrl: 'fixture' }] }
    : data.tlang ? translated.promise : original.promise);
  const first = h.loadCaptions();
  assert.equal(h.loadCaptions(true), first, 'same load is reused even when a CC retry requests a force refresh');
  h.signal('LM_READY'); h.signal('LM_NAVIGATE'); h.signal('LM_CAPTIONS', 'alpha');
  await settle();
  assert.equal(h.requests.filter(request => request.type === 'LM_FETCH_TRACK').length, 1);
  assert.equal(h.state.loadGen, 1);
  original.resolve({ text: trackText() }); await settle();
  const cue = h.state.cues[0], panelRenders = h.counts.panels, sourceRenders = h.counts.current;
  assert.equal(cue.text, 'first caption', 'source appears before translated track finishes');
  translated.resolve({ text: trackText('完整译文') }); await first;
  assert.equal(h.state.nativeCues[0].text, '完整译文');
  assert.equal(h.state.cues[0], cue);
  assert.equal(h.counts.panels, panelRenders, 'translation arrival does not rebuild source transcript');
  assert.equal(h.counts.current, sourceRenders, 'translation arrival does not rebuild overlay source words');
  assert.ok(h.counts.updated.includes(0));
  const before = h.requests.length;
  h.signal('LM_NAVIGATE'); await settle();
  assert.equal(h.requests.length, before, 'a redundant ready event does not refetch a ready video');
});

test('same-video refresh preserves usable captions, inline corrections and translations when a request fails', async () => {
  const h = harness(); await h.loadCaptions();
  const cue = h.state.cues[0], native = h.state.nativeCues[0];
  cue.originalText = cue.text; cue.text = 'corrected source';
  const renders = h.counts.panels;
  await h.loadCaptions(true);
  assert.equal(h.state.cues[0], cue); assert.equal(cue.text, 'corrected source');
  assert.equal(h.state.nativeCues[0], native);
  assert.equal(h.counts.panels, renders);
  h.handler(async () => null); await h.loadCaptions(true);
  assert.equal(h.state.cues[0], cue); assert.equal(h.state.nativeCues[0], native);
  assert.equal(h.state.status, 'ready'); assert.equal(h.counts.panels, renders);
});

test('returning to a recently visited video restores its timed tracks without network work', async () => {
  const h = harness(); await h.loadCaptions();
  const alpha = h.state.cues;
  h.location.href = 'https://www.youtube.com/watch?v=beta'; await h.loadCaptions();
  const before = h.requests.length;
  h.location.href = 'https://www.youtube.com/watch?v=alpha'; await h.loadCaptions();
  assert.equal(h.state.cues, alpha);
  assert.equal(h.state.captionKey, 'alpha|ja|zh-CN');
  assert.equal(h.requests.length, before);
});

test('old player metadata cannot be used after track discovery times out during navigation', async () => {
  const h = harness();
  h.handler(async type => type === 'LM_PING' ? { ok: true } : { videoId: 'previous-video', tracks: [{ languageCode: 'ja', baseUrl: 'wrong-video' }] });
  await h.loadCaptions();
  assert.equal(h.state.cues.length, 0);
  assert.match(h.state.statusText, /切换视频/);
  assert.equal(h.requests.filter(request => request.type === 'LM_FETCH_TRACK').length, 0);
});

test('late tracks cannot replace a newer video or revive subtitles after leaving the player', async () => {
  const h = harness(), old = deferred();
  h.handler(async (type, data) => type === 'LM_PING' ? { ok: true } : type === 'LM_GET_TRACKS'
    ? { videoId: new URL(h.location.href).searchParams.get('v'), tracks: [{ languageCode: 'ja', baseUrl: 'fixture' }] }
    : data.videoId === 'alpha' ? old.promise : { text: trackText(data.tlang ? 'beta translation' : 'beta source') });
  const loading = h.loadCaptions(); await settle();
  h.location.href = 'https://www.youtube.com/watch?v=beta'; await h.loadCaptions();
  old.resolve({ text: trackText('stale alpha') }); await loading;
  assert.equal(h.state.cues[0].text, 'beta source');
  const next = deferred(); h.handler(async type => type === 'LM_PING' ? next.promise : null);
  const refreshing = h.loadCaptions(true);
  h.location.href = 'https://www.youtube.com/'; await h.loadCaptions();
  next.resolve({ ok: true }); await refreshing;
  assert.equal(h.requests.at(-1).type, 'LM_PING', 'the obsolete refresh stops before requesting tracks');
});

test('a captured caption arriving during a failed first read schedules one later retry', async () => {
  const h = harness(), first = deferred();
  h.handler(async (type, data) => type === 'LM_PING' ? { ok: true } : type === 'LM_GET_TRACKS'
    ? { videoId: 'alpha', tracks: [{ languageCode: 'ja', baseUrl: 'fixture' }] } : first.promise);
  const loading = h.loadCaptions(); await settle();
  h.signal('LM_CAPTIONS', 'alpha'); h.signal('LM_CAPTIONS', 'alpha');
  assert.equal(h.timers.size, 0, 'capture notifications do not restart in-flight work');
  first.resolve({ text: '' }); await loading;
  assert.equal(h.timers.size, 1);
  h.handler(async type => type === 'LM_PING' ? null : null);
  h.runTimers(); await settle();
  assert.equal(h.timers.size, 0, 'one failed retry does not spin indefinitely');
});

test('page-hook readiness during a missed initial ping is not lost by load coalescing', async () => {
  const h = harness(), ping = deferred();
  h.handler(async () => ping.promise);
  const loading = h.loadCaptions();
  h.signal('LM_READY');
  ping.resolve(null); await loading;
  assert.equal(h.timers.size, 1, 'the ready signal schedules recovery after the missed ping completes');
});
