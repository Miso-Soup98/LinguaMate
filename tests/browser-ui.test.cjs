const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((name) => name && fs.existsSync(name));

// Run the real background storage handler and content scripts together, using
// isolated in-memory Chrome storage and deterministic dictionary responses.
const bridge = `
window.setInterval = () => 0;
window.fixtureData = {sync:{},local:{vocab:[],known:{}}};
window.fixtureListeners = [];
window.fixtureLookups = [];
window.fixtureDeferredLookup = false;
function area(name) {
  return {
    async get(defaults) { return structuredClone({...defaults,...fixtureData[name]}); },
    async set(patch) {
      const changes = {};
      for (const [key,value] of Object.entries(patch)) {
        changes[key] = {oldValue:fixtureData[name][key],newValue:structuredClone(value)};
        fixtureData[name][key] = structuredClone(value);
      }
      queueMicrotask(() => fixtureListeners.forEach(fn => fn(changes,name)));
    }
  };
}
window.chrome = {
 runtime:{id:'browser-regression',onInstalled:{addListener(){}},onMessage:{addListener(){}},
  sendMessage(message,callback){
    if(message.type==='LM_LOOKUP') {
      fixtureLookups.push({message,callback});
      if(!fixtureDeferredLookup) callback({ok:true,result:{word:message.word,translation:'fixture meaning'}});
      return;
    }
    if(message.type==='LM_TRANSLATE') return callback({ok:true,result:{text:message.text}});
    if(message.type==='LM_JA_ANALYZE') return callback({ok:true,tokens:Array.from(new Intl.Segmenter('ja',{granularity:'word'}).segment(message.text),part=>({text:part.segment,surface:part.segment,lemma:part.segment,isWordLike:part.isWordLike,reading:'',baseReading:'',pos:'',conjugation:{labels:[]}}))});
    handleMessage(message).then(callback,error=>callback({ok:false,error:String(error.message)}));
  }},
 storage:{sync:area('sync'),local:area('local'),onChanged:{addListener(fn){fixtureListeners.push(fn)}}},
 contextMenus:{onClicked:{addListener(){}}}
};
window.fixtureResults = [];
window.fixtureCheck = (label,passed) => { if(!passed) throw new Error(label); fixtureResults.push(label); document.title='LM_BROWSER_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:'running',checks:fixtureResults})))); };
window.addEventListener('error',event=>{document.title='LM_BROWSER_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:false,error:event.message,checks:fixtureResults}))));});
window.settleFixture = async () => { for(let i=0;i<100;i++) await Promise.resolve(); };
window.checkWordInteraction = async (platform, label) => {
  const words = platform.ui.learningLine.querySelectorAll('.lm-word');
  const first = words[0], second = words[1];
  fixtureDeferredLookup = true;
  let playbackClicks = 0;
  platform.ui.learningLine.addEventListener('click', () => playbackClicks++);
  second.click(); await settleFixture();
  fixtureCheck(label+' clicking a word immediately opens its loading card', fixtureLookups.at(-1).message.word===second.dataset.word && platform.ui.dict.textContent.includes('正在查询'));
  fixtureCheck(label+' word clicks do not bubble into seek/play controls',playbackClicks===0);
  const side = platform.ui.dict.dataset.anchorSide;
  const loading = platform.ui.dict.getBoundingClientRect();
  const nearby = first.getBoundingClientRect();
  fixtureCheck(label+' the neighbouring word remains reachable with a card open',first.contains(document.elementFromPoint(nearby.left+nearby.width/2,nearby.top+nearby.height/2)));
  fixtureLookups.at(-1).callback({ok:true,result:{word:second.dataset.word,translation:'second meaning',entries:[{pos:'noun',items:Array.from({length:6},(_,i)=>({definition:'A long dictionary meaning '+i+' with enough detail to expand the card vertically.',gloss:'已经翻译的详细义项 '+i}))}]}});
  await settleFixture();
  const expanded = platform.ui.dict.getBoundingClientRect();
  fixtureCheck(label+' loaded definitions preserve the edge next to the word',platform.ui.dict.dataset.anchorSide===side&&Math.abs(loading[side==='below'?'top':'bottom']-expanded[side==='below'?'top':'bottom'])<1);
  fixtureCheck(label+' expanded definitions stay within the viewport',expanded.top>=7&&expanded.bottom<=innerHeight-7);
  const count = fixtureLookups.length;
  first.click();
  fixtureCheck(label+' a previously viewed word returns synchronously without a loading flash',fixtureLookups.length===count&&!platform.ui.dict.textContent.includes('正在查询')&&platform.ui.dict.querySelector('.lm-dict-word').textContent===first.dataset.word);
  fixtureCheck(label+' selection highlight follows the current word',first.classList.contains('lm-word-active')&&!second.classList.contains('lm-word-active'));
  const range = document.createRange(); range.selectNodeContents(second);
  getSelection().removeAllRanges();getSelection().addRange(range);
  second.click();
  fixtureCheck(label+' selecting text does not start an incidental lookup',fixtureLookups.length===count);
  getSelection().removeAllRanges();fixtureDeferredLookup=false;platform.hideDict();
  // Keep real DOM event propagation and hit testing, but advance hover timers
  // deterministically. Native :hover is supplied explicitly in headless mode.
  const originalSet = window.setTimeout, originalClear = window.clearTimeout;
  const timers = new Map(); let clock = 0, serial = 0;
  window.setTimeout = (fn,delay=0) => {const id=++serial;timers.set(id,{fn,at:clock+delay});return id;};
  window.clearTimeout = id => timers.delete(id);
  const advance = ms => {const until=clock+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);clock=next[1].at;next[1].fn();}clock=until;};
  for(const word of words){const matches=word.matches.bind(word);word.matches=selector=>selector===':hover'?word.fixtureHover===true:matches(selector);}
  const enter = (word,from=null) => {
    if(from){from.fixtureHover=false;from.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:word}));}
    word.fixtureHover=true;word.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:from}));
  };
  try {
    enter(first);advance(150);
    const ruby=document.createElement('ruby'),rt=document.createElement('rt');rt.textContent='reading';ruby.append(rt);first.append(ruby);
    first.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:rt}));
    rt.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:first}));
    advance(69);fixtureCheck(label+' initial hover requires deliberate intent',platform.ui.dict.classList.contains('lm-hidden'));
    advance(1);await settleFixture();
    fixtureCheck(label+' ruby movement does not restart the initial hover delay',first.classList.contains('lm-word-active')&&!platform.ui.dict.classList.contains('lm-hidden'));
    enter(second,first);advance(119);
    fixtureCheck(label+' quick crossings retain the selected word',first.classList.contains('lm-word-active'));
    advance(1);await settleFixture();
    fixtureCheck(label+' continuous selection switches at 120 milliseconds',second.classList.contains('lm-word-active')&&!first.classList.contains('lm-word-active'));
    enter(first,second);advance(60);enter(second,first);advance(500);
    fixtureCheck(label+' returning to the selected word cancels the intermediate switch',second.classList.contains('lm-word-active')&&fixtureLookups.length===count);
    ruby.remove();platform.hideDict();
  } finally {
    window.setTimeout=originalSet;window.clearTimeout=originalClear;
    for(const word of words){delete word.matches;delete word.fixtureHover;}
  }
};
`;

const youtubeCheck = `
const y = fixture;
y.ensureUi();
document.querySelector('.html5-video-player').append(y.ui.root);
document.body.append(y.ui.panel);
const v = document.querySelector('video');
Object.defineProperty(v,'currentTime',{value:0.5,writable:true});
Object.defineProperty(v,'paused',{get(){return this.fixturePaused ?? false;}});
v.pause=()=>{v.fixturePaused=true;}; v.play=()=>{v.fixturePaused=false;return Promise.resolve();};
y.replacePageRequest(async(type,data)=>{
 if(type==='LM_PING') return {};
 if(type==='LM_GET_TRACKS')return {videoId:'fixture',tracks:[{baseUrl:'fixture',languageCode:y.state.settings.learningLang}]};
 if(type==='LM_FETCH_TRACK')return {text:JSON.stringify({events:[{tStartMs:0,dDurationMs:1800,segs:[{utf8:y.state.settings.learningLang==='ja'?'日本語の字幕です。':'English caption.'}]}]})};
});
y.state.cues=[{start:0,end:1800,text:'hello world'}];
y.renderTranscript();y.renderCurrent();
await y.showDict(y.ui.learningLine.querySelector('.lm-word'));await y.ui.vocabButton.ready;
let button=y.ui.dict.querySelector('.lm-dict-save');button.click();await y.ui.vocabButton.pending;
fixtureCheck('YouTube persists a confirmed save',fixtureData.local.vocab.length===1&&button.getAttribute('aria-pressed')==='true');
button.click();await y.ui.vocabButton.pending;
fixtureCheck('YouTube second click removes the saved record',fixtureData.local.vocab.length===0&&button.getAttribute('aria-pressed')==='false');
await checkWordInteraction(y,'YouTube');
v.currentTime=10;y.renderCurrent();
fixtureCheck('YouTube hides expired captions but keeps replay navigation',y.ui.learningLine.classList.contains('lm-hidden')&&y.state.index===0&&y.state.activeIndex===-1);
await Promise.all([chrome.storage.sync.set({enabled:false}),chrome.storage.local.set({vocab:[]})]);await settleFixture();
fixtureCheck('Simultaneous setting and vocabulary events disable the UI',!y.state.settings.enabled&&y.ui.root.classList.contains('lm-hidden')&&!document.documentElement.classList.contains('lm-hide-yt-captions'));
await Promise.all([chrome.storage.sync.set({enabled:true,learningLang:'ja',listenMode:true,fontSize:30}),chrome.storage.local.set({vocab:[]})]);await settleFixture();
fixtureCheck('Simultaneous changes reload the selected subtitle language',y.state.settings.learningLang==='ja'&&y.state.cues[0].text==='日本語の字幕です。');
fixtureCheck('YouTube applies font size and listening mode',y.ui.learningLine.style.fontSize==='30px'&&y.ui.subs.classList.contains('lm-listen'));
fixtureCheck('Listening subtitles are hidden until hover',getComputedStyle(y.ui.learningLine).opacity==='0');
await y.persist({listenMode:false,autoPause:true});await settleFixture();
y.state.cues=[{start:0,end:1800,text:'Current sentence'},{start:3000,end:4500,text:'Next sentence'}];
v.currentTime=1.6;y.renderCurrent();y.onTick();v.currentTime=1.9;y.onTick();
fixtureCheck('YouTube auto-pause stops at the actual subtitle end',v.fixturePaused===true);
fixtureCheck('YouTube expired subtitle stays hidden after auto-pause',y.ui.learningLine.classList.contains('lm-hidden'));
`;

const primeCheck = String.raw`
const p=fixture,v=document.querySelector('video');
Object.defineProperty(v,'currentTime',{value:0.5,writable:true});
Object.defineProperty(v,'paused',{get(){return this.fixturePaused ?? false;}});
v.pause=()=>{v.fixturePaused=true;};v.play=()=>{v.fixturePaused=false;return Promise.resolve();};
p.mount();
p.applyTrack('<tt xml:lang="en"><body><div><p begin="0s" end="1.8s">hello world</p><p begin="3s" end="4.5s">another sentence</p></div></body></tt>');
await settleFixture();
fixtureCheck('Prime parses full XML subtitles with the real DOM',p.state.cues.length===2&&p.state.fullTrack);
await p.showDict(p.ui.learningLine.querySelector('.lm-word'));await p.ui.vocabButton.ready;
let button=p.ui.dict.querySelector('.lm-dict-save');button.click();await p.ui.vocabButton.pending;
fixtureCheck('Prime dictionary saves through the real storage queue',fixtureData.local.vocab.length===1&&button.getAttribute('aria-pressed')==='true');
button.click();await p.ui.vocabButton.pending;
fixtureCheck('Prime dictionary removes through the real storage queue',fixtureData.local.vocab.length===0&&button.getAttribute('aria-pressed')==='false');
await checkWordInteraction(p,'Prime');
v.currentTime=2;p.renderCurrent();fixtureCheck('Prime clears subtitle gaps',p.ui.learningLine.classList.contains('lm-hidden')&&p.state.index===0);
await chrome.storage.sync.set({enabled:false});await settleFixture();
fixtureCheck('Prime disable restores the native caption layer',p.ui.root.classList.contains('lm-hidden')&&!document.documentElement.classList.contains('lm-prime-captions'));
await chrome.storage.sync.set({enabled:true,fontSize:30,playbackRate:0.75,showNative:false,listenMode:true,panelOpen:false});await settleFixture();
fixtureCheck('Prime synchronizes saved settings live',p.ui.learningLine.style.fontSize==='30px'&&v.playbackRate===0.75&&p.ui.panel.classList.contains('lm-collapsed')&&p.ui.subs.classList.contains('lm-listen'));
await p.togglePanel();fixtureCheck('Prime panel preference persists successfully',fixtureData.sync.panelOpen===true&&!p.ui.panel.classList.contains('lm-collapsed'));
await chrome.storage.sync.set({learningLang:'ja',listenMode:false});await settleFixture();
p.applyTrack('WEBVTT\nLanguage: ja\n\n00:00.000 --> 00:03.000\n日本語の字幕です。');v.currentTime=0.5;p.renderCurrent();
await p.showDict(p.ui.learningLine.querySelector('.lm-word'));await p.ui.vocabButton.ready;
fixtureCheck('Prime non-English cards use the selected-language pronunciation control',!!p.ui.dict.querySelector('[data-accent="read"]')&&!p.ui.dict.querySelector('[data-accent="us"]'));
fixtureCheck('Prime panel remains inside the viewport',p.ui.panel.getBoundingClientRect().bottom<=innerHeight+1);
`;

for (const platform of ["youtube", "prime"]) {
  test(`${platform} UI uses real Chrome DOM and the background storage handler`, { timeout: 45000 }, (t) => {
    if (!chrome) return t.skip("Set CHROME_PATH to enable browser integration tests");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-browser-ui-"));
    try {
      let content = source(`src/content/${platform}.js`);
      const expose = platform === "prime"
        ? "window.fixture={state,ui,mount,applyTrack,renderCurrent,showDict,hideDict,togglePanel};"
        : "window.fixture={state,ui,ensureUi,renderTranscript,renderCurrent,showDict,hideDict,persist,onTick,replacePageRequest(fn){requestPage=fn;}};";
      content = platform === "prime" ? content.replace("  boot();", expose)
        : content.replace('  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);\n  else boot();', expose);
      const checks = platform === "prime" ? primeCheck : youtubeCheck;
      const finish = `
      (async()=>{try{${checks}\n document.title='LM_BROWSER_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:true,checks:fixtureResults}))));}
      catch(error){document.title='LM_BROWSER_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:false,error:error.stack,checks:fixtureResults}))));}})();`;
      const scripts = [bridge, source("src/background/service-worker.js"), ...["languages", "defaults", "frequency", "captions", "feedback", "japanese", "japanese-ui", "japanese-client", "vocab-button", "word-card", "dict-session", "prime-manifest", "prime-timeline"].map((name) => source(`src/shared/${name}.js`)), content, finish];
      const html = `<!doctype html><meta charset="utf-8"><title>pending</title><style>body{margin:0;background:#111}video{display:block;width:800px;height:450px}${source("src/content/youtube.css")}${source("src/content/prime.css")}</style><div class="html5-video-player"><video></video></div>${scripts.map((script) => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`;
      const file = path.join(directory, `${platform}.html`);
      fs.writeFileSync(file, html, "utf8");
      const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1280,900", "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href + "?v=fixture"], { encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const encoded = output.match(/<title>LM_BROWSER_RESULT:([^<]+)<\/title>/)?.[1];
      assert.ok(encoded, `Browser did not complete: ${output.slice(0, 300)}`);
      const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.equal(result.passed, true, JSON.stringify(result, null, 2));
      assert.ok(result.checks.length >= 9);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
