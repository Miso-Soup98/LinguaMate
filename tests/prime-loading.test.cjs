const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { primeHarness } = require('./prime-harness.cjs');

const track = 'WEBVTT\nLanguage: en\n\n00:00.000 --> 00:04.000\nFirst sentence\n\n00:04.000 --> 00:08.000\nSecond sentence';

test('duplicate Prime tracks retain translated rows and do not restart translation', async () => {
  const h = primeHarness({ deferredTranslation: true });
  h.prime.applyTrack(track, 'en');
  h.pendingTranslations[0].callback({ok:true,result:{text:'[0] 第一行\n[1] 第二行'}});
  await h.flush();
  const native = h.prime.ui.cueRows[0].querySelector('.lm-cue-native');
  const token = h.prime.state.token;
  h.prime.applyTrack(track, 'en-US');
  assert.equal(h.prime.state.native[0], '第一行');
  assert.equal(h.prime.state.token, token);
  assert.equal(h.pendingTranslations.length, 1);
  assert.equal(h.prime.ui.cueRows[0].querySelector('.lm-cue-native'), native);
  assert.equal(native.isConnected, true);
  h.prime.applyTrack(track.replace('First sentence', 'Corrected sentence'), 'en');
  assert.equal(h.prime.state.cues[0].text, 'Corrected sentence');
  assert.equal(h.pendingTranslations.length, 2);
});

test('Prime translation starts near playback, reprioritizes after a seek, and updates only the returned rows', async () => {
  const h = primeHarness({ deferredTranslation: true });
  h.cues(150);
  h.video.currentTime = 181;
  h.prime.renderCurrent();
  const untouched = h.prime.ui.cueRows[10];
  let reads = 0;
  const query = untouched.querySelector.bind(untouched);
  untouched.querySelector = (...args) => { reads++; return query(...args); };
  const pending = h.prime.translateCues(h.prime.state.cues, h.prime.state.token);
  assert.equal(h.pendingTranslations.length, 2, 'two workers bound simultaneous translation requests');
  assert.match(h.pendingTranslations[0].message.text, /^\[90\]/);
  assert.match(h.pendingTranslations[1].message.text, /^\[120\]/);
  h.video.currentTime = 61;
  h.prime.renderCurrent();
  h.pendingTranslations[0].callback({ok:true,result:{text:'［90］ 完整译文'}});
  await h.flush();
  assert.equal(h.prime.state.native[90], '完整译文');
  assert.match(h.pendingTranslations[2].message.text, /^\[30\]/, 'next work reflects the new playback position');
  assert.equal(reads, 0, 'translation does not walk every unrelated transcript row');
  h.prime.state.token += 1;
  h.pendingTranslations[1].callback({ok:true,result:{text:'[120] obsolete'}});
  h.pendingTranslations[2].callback({ok:true,result:{text:'[30] obsolete'}});
  await pending;
  assert.equal(h.prime.state.native[120], '');
  assert.equal(h.prime.state.native[30], '');
});

test('calling the same Prime translation task twice shares pending work', async () => {
  const h = primeHarness({ deferredTranslation: true });
  h.cues(2);
  const first = h.prime.translateCues(h.prime.state.cues, h.prime.state.token);
  const second = h.prime.translateCues(h.prime.state.cues, h.prime.state.token);
  assert.equal(h.pendingTranslations.length, 1);
  h.pendingTranslations[0].callback({ok:true,result:{text:'[0] result'}});
  await Promise.all([first, second]);
  assert.equal(h.prime.state.native[0], 'result');
});

function hookHarness(fetch) {
  let now = 0, next = 0;
  const timers = new Map(), requests = [], posts = [];
  const location = {href:'https://www.primevideo.com/detail/one'};
  class XHR { open() {} send() {} }
  const window = {fetch:(url, options) => { requests.push({url,options}); return fetch(url,options); }, postMessage:message=>posts.push(message), addEventListener() {}};
  const scope = vm.createContext({window, location, URL, AbortController, XMLHttpRequest:XHR,
    document:{querySelectorAll:()=>[]},
    setTimeout:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id)
  });
  const source = fs.readFileSync(path.resolve(__dirname,'../src/injected/prime.js'),'utf8').replace(/\r\n/g,'\n')
    .replace('\n}\n\n// The manifest', '\n globalThis.hook={loadTrackList,pullTracks,requestSession,rememberEnvelope};\n}\n\n// The manifest');
  vm.runInContext(source, scope);
  return {hook:scope.hook,requests,posts,location,
    advance(ms){now+=ms;for(const[id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}},
    async flush(){for(let i=0;i<30;i++)await Promise.resolve();}
  };
}
const response = text => ({ok:true,headers:{get:()=> 'application/ttml+xml'},text:async()=>text});
const subtitle = '<tt xml:lang="en"><body><p begin="0s" end="2s">Programme subtitles</p></body></tt>';
const tracks = [{url:'https://video.example/programme.ttml',lang:'en'}];

test('Prime hook coalesces concurrent track pulls and replays successful cached text', async () => {
  let release;
  const h=hookHarness(()=>new Promise(resolve=>{release=resolve;}));
  const session=h.hook.requestSession();
  const first=h.hook.loadTrackList(tracks,session), second=h.hook.loadTrackList(tracks,session);
  assert.equal(h.requests.length,1);
  release(response(subtitle));await Promise.all([first,second]);
  assert.equal(h.posts.length,1);
  await h.hook.loadTrackList(tracks,session);
  assert.equal(h.requests.length,1);
  assert.equal(h.posts.length,2,'cached text replays for a late content listener');
});

test('Prime hook timeouts release pending work and allow the next subtitle retry', async () => {
  let succeed=false;
  const h=hookHarness(()=>succeed?Promise.resolve(response(subtitle)):new Promise(()=>{}));
  const session=h.hook.requestSession();
  const first=h.hook.loadTrackList(tracks,session);
  h.advance(8000);await h.flush();
  assert.equal(h.requests.length,2,'fallback credential mode is also bounded');
  h.advance(8000);await first;
  assert.equal(h.posts.length,0);
  succeed=true;await h.hook.loadTrackList(tracks,session);
  assert.equal(h.requests.length,3);
  assert.equal(h.posts[0].text,subtitle);
  assert.ok(h.requests.slice(0,2).every(request=>request.options.signal.aborted));
});

test('Prime hook scopes cached text to the programme and rejects late old responses', async () => {
  const releases=[];
  const h=hookHarness(()=>new Promise(resolve=>releases.push(resolve)));
  const old=h.hook.loadTrackList(tracks,h.hook.requestSession());
  h.location.href='https://www.primevideo.com/detail/two';
  const current=h.hook.loadTrackList(tracks,h.hook.requestSession());
  releases[0](response(subtitle.replace('Programme','Old programme')));await old;
  assert.equal(h.posts.length,0);
  releases[1](response(subtitle));await current;
  assert.equal(h.requests.length,2);
  assert.equal(h.posts.length,1);
  assert.match(h.posts[0].scope,/detail\/two/);
});

test('a hung playback-resource pull can be retried after its deadline', async () => {
  const h=hookHarness(()=>new Promise(()=>{}));
  const session=h.hook.requestSession();
  h.hook.rememberEnvelope('https://video.example/GetPlaybackResources',JSON.stringify({globalParameters:{playbackEnvelope:'fixture'}}),session);
  const first=h.hook.pullTracks();
  await h.hook.pullTracks();assert.equal(h.requests.length,1);
  h.advance(8000);await first;
  const retry=h.hook.pullTracks();assert.equal(h.requests.length,2);
  h.advance(8000);await retry;
});
