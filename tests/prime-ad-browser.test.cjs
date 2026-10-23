const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));

// Exercise the shipping content script, CSS, real layout and postMessage event
// dispatch. Only the browser-extension bridge and media transport are fixtures;
// no account, advertisement service or actual playback is needed.
const bridge = `
window.fixtureClock=0;window.fixtureMedia=0;window.fixtureRequests=[];window.fixtureChecks=[];
window.setInterval=()=>0;
Object.defineProperty(performance,'now',{value:()=>fixtureClock});
window.chrome={runtime:{id:'prime-ad-browser',sendMessage(message,callback){
  fixtureRequests.push(message);
  if(message.type==='LM_TRANSLATE')callback({ok:true,result:{text:message.text}});
  else if(message.type==='LM_VOCAB_LIST')callback({ok:true,vocab:[],known:{}});
  else if(message.type==='LM_JA_ANALYZE')callback({ok:false,error:'not_used'});
  else callback({ok:true});
}},storage:{local:{get(_key,callback){callback({});},set(){}},onChanged:{addListener(){}}}};
window.check=(label,passed)=>{if(!passed)throw Error(label);fixtureChecks.push(label);};
window.settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
window.post=async message=>{
  window.postMessage({source:'linguamate-prime',...message},'*');
  await new Promise(resolve=>setTimeout(resolve,0));await settle();
};
const fixtureVideo=document.querySelector('video');
Object.defineProperties(fixtureVideo,{
  currentTime:{get:()=>fixtureMedia,set:value=>{fixtureMedia=value;},configurable:true},
  currentSrc:{value:'blob:programme',writable:true,configurable:true},
  paused:{value:false,writable:true,configurable:true},
  seeking:{value:false,writable:true,configurable:true},
  textTracks:{value:[],writable:true,configurable:true},
  playbackRate:{get(){return this.fixtureRate??1;},set(value){this.fixtureRate=value;this.rateWrites=(this.rateWrites||0)+1;},configurable:true}
});
fixtureVideo.pauseCalls=0;fixtureVideo.playCalls=0;
fixtureVideo.pause=()=>{fixtureVideo.pauseCalls++;fixtureVideo.paused=true;};
fixtureVideo.play=()=>{fixtureVideo.playCalls++;fixtureVideo.paused=false;return Promise.resolve();};
`;

const checks = `
const p=prime,v=fixtureVideo,marker=document.querySelector('.atvwebplayersdk-adtimeindicator-text'),markerParent=marker.parentElement;
const native=document.querySelector('.atvwebplayersdk-captions-overlay');
const originalCues=[{start:8000,end:10000,text:'The programme before the advertisement.'},{start:10000,end:12000,text:'The programme resumes in sync.'},{start:12000,end:18000,text:'Study the next sentence.'}];
function prepare(){
  markerParent.style.cssText='';markerParent.hidden=true;markerParent.removeAttribute('aria-hidden');marker.textContent='Ad 0:30';
  fixtureClock=0;fixtureMedia=0;v.currentSrc='blob:programme';v.paused=false;v.seeking=false;v.pauseCalls=0;v.playCalls=0;
  p.playback.timeline.reset();p.playback.manifest=false;p.playback.last=null;p.playback.ad=null;p.playback.pendingTrack=null;
  p.state.adActive=false;p.state.fullTrack=false;p.state.trackClock='content';p.state.lastTickMs=null;p.state.lastLive='';
  p.state.settings={...p.state.settings,enabled:true,autoPause:true,playbackRate:.75,panelOpen:true,showLearning:true,showNative:true};
  p.state.cues=originalCues.map(cue=>({...cue}));p.state.native=['广告前的正片字幕。','正片字幕恢复同步。','学习下一句话。'];p.state.trackLang='en';
  p.state.index=p.state.activeIndex=-1;p.mount();p.renderPanel();p.renderCurrent();
}
function at(seconds,milliseconds=seconds*1000){fixtureClock=milliseconds;fixtureMedia=seconds;p.onTick();}
function showMarker(){markerParent.hidden=false;marker.textContent='Ad 0:30';p.onTick();}
function hideMarker(){markerParent.hidden=true;p.onTick();}

// Current Amazon Japan markup has this class only on the countdown text.
// Its random-class parents cannot be found through the older ad-timer selector.
prepare();at(9);
marker.className='atvwebplayersdk-ad-timer-remaining-time';markerParent.className='fixture-random-ad-parent';
markerParent.setAttribute('aria-label','広告を再生しています。コンテンツは、1分48秒後に再開されます。');
markerParent.hidden=false;marker.textContent='1:48';markerParent.style.display='none';at(9.1);
check('a current countdown inside a display-hidden ancestor does not freeze the programme',!p.hasAdIndicator()&&!p.state.adActive);
markerParent.style.display='';markerParent.style.opacity='0';at(9.2);
check('a current countdown inside an opacity-hidden ancestor does not freeze the programme',!p.hasAdIndicator()&&!p.state.adActive);
markerParent.style.opacity='';marker.textContent='   ';at(9.3);
check('an empty current countdown template does not freeze the programme',!p.hasAdIndicator()&&!p.state.adActive);
markerParent.hidden=true;marker.textContent='1:48';at(10);markerParent.hidden=false;p.onTick();
const currentTimerRow=p.ui.activeRow,currentTimerIndex=p.state.activeIndex,currentTimerScroll=p.ui.panelBody.scrollTop;
check('the current Amazon Japan remaining-time marker enters advertising without a legacy parent class',p.hasAdIndicator()&&p.state.adActive);
check('the current Amazon Japan countdown hides study captions and shows the ad status',getComputedStyle(p.ui.subs).display==='none'&&!p.ui.adStatus.hidden);
marker.textContent='0:55';at(63);
check('a countdown-only ad freezes the programme row and transcript scroll',p.ui.activeRow===currentTimerRow&&p.state.activeIndex===currentTimerIndex&&p.ui.panelBody.scrollTop===currentTimerScroll&&p.contentTimeMs()===10000);
await post({type:'LM_TRACK',lang:'en',text:'WEBVTT\\n\\n00:00.000 --> 00:03.000\\nAn advertisement'});
check('the current countdown blocks advertisement subtitles from replacing the programme',p.state.cues[0].text===originalCues[0].text);
at(118);hideMarker();at(118.401,118401);await settle();
check('the current countdown resumes the programme without adding its 108 seconds to subtitle time',!p.state.adActive&&Math.abs(p.contentTimeMs()-10401)<.001&&p.ui.learningLine.textContent===originalCues[1].text);
marker.className='atvwebplayersdk-adtimeindicator-text';markerParent.className='';markerParent.removeAttribute('aria-label');

prepare();
await post({type:'LM_PRIME_MPD',role:'content',adActive:false,text:'<MPD mediaPresentationDuration="PT2M"><Period duration="PT10S"/><Period start="PT10S" duration="PT30S"><Role value="Ad"/></Period><Period start="PT40S"/></MPD>'});
check('raw MPD fallback is parsed in the content realm and restores exact advertising boundaries',JSON.stringify(p.playback.timeline.breaks())==='[{"start":10000,"end":40000}]');
await post({type:'LM_PRIME_MPD',role:'content',adActive:false,text:'<MPD><Period start="PT20S"/></MPD>'});
check('an incomplete raw MPD cannot erase a valid content timeline',p.playback.timeline.breaks()[0].end===40000);

prepare();at(9.5);
await post({type:'LM_PRIME_TIMELINE',breaks:[{start:10000,end:40000}]});
const beforeRow=p.ui.activeRow,beforeIndex=p.state.activeIndex,beforeScroll=p.ui.panelBody.scrollTop;
check('native programme captions are hidden while the study overlay is active',getComputedStyle(native).opacity==='0');
at(10);showMarker();
check('MPD and the visible ad timer enter advertising state',p.state.adActive===true);
check('real CSS hides the study subtitle overlay throughout the ad',getComputedStyle(p.ui.subs).display==='none');
check('advertising shows a readable live status without discarding transcript rows',!p.ui.adStatus.hidden&&p.ui.adStatus.textContent.includes('广告播放中')&&p.ui.panelBody.querySelectorAll('.lm-cue').length===3);
check('advertising restores native caption visibility',!document.documentElement.classList.contains('lm-prime-captions')&&getComputedStyle(native).opacity==='1');
check('the programme active row and transcript scroll remain frozen at ad entry',p.ui.activeRow===beforeRow&&p.state.activeIndex===beforeIndex&&p.ui.panelBody.scrollTop===beforeScroll);
v.playbackRate=1;const adRateWrites=v.rateWrites;
at(25);p.syncSettings();
check('ad playback is not changed by the study rate setting',v.playbackRate===1&&v.rateWrites===adRateWrites);
check('crossing a programme sentence end during ads cannot auto-pause the ad',v.pauseCalls===0);
p.seekTo(8000,true);
check('transcript seeking is ignored while advertising is active',fixtureMedia===25&&v.playCalls===0);
await post({type:'LM_TRACK',lang:'en',text:'WEBVTT\\n\\n00:00.000 --> 00:03.000\\nAn advertisement'});
check('unsourced ad subtitles cannot replace the programme transcript',p.state.cues[0].text===originalCues[0].text);
at(40);hideMarker();
check('the end of the ad retains a short stable-source recovery state',p.state.adActive&&p.ui.adStatus.textContent.includes('恢复正片'));
at(40.399,40399);
check('the 400 millisecond recovery interval does not leak subtitles',p.state.adActive&&getComputedStyle(p.ui.subs).display==='none');
at(40.401,40401);await settle();
check('the exact MPD boundary resumes programme time without counting debounce as advertising',!p.state.adActive&&Math.abs(p.contentTimeMs()-10401)<.001);
check('the correct programme sentence is active after advertising',p.state.activeIndex===1&&p.ui.learningLine.textContent===originalCues[1].text);
check('native captions and the study overlay return to their programme visibility',document.documentElement.classList.contains('lm-prime-captions')&&getComputedStyle(native).opacity==='0'&&getComputedStyle(p.ui.subs).display!=='none'&&p.ui.adStatus.hidden);
check('the selected study playback rate returns after the ad',v.playbackRate===.75);
p.seekTo(12000,true);
check('a forward content seek maps through the inserted ad interval',Math.abs(fixtureMedia-42.01)<.00001&&v.playCalls===1);
p.seekTo(8000,false);
check('a backward seek before the ad does not retain a global cumulative offset',Math.abs(fixtureMedia-8.01)<.00001&&Math.abs(p.contentTimeMs()-8010)<.001);
p.seekTo(10000,true);
check('seeking to the shared content boundary skips to the end of the ad',Math.abs(fixtureMedia-40.01)<.00001);

prepare();await post({type:'LM_PRIME_TIMELINE',breaks:[{start:10000,end:40000}]});
at(12);
check('known MPD ad intervals work even without a visible countdown',p.state.adActive===true&&markerParent.hidden);
at(40);at(40.401,40401);await settle();
check('MPD-only advertising resumes with the same exact content mapping',!p.state.adActive&&Math.abs(p.contentTimeMs()-10401)<.001);

for(const emptyManifest of [false,true]){
  prepare();at(10);if(emptyManifest)await post({type:'LM_PRIME_TIMELINE',breaks:[]});
  showMarker();at(25);at(40);hideMarker();at(40.401,40401);await settle();
  check(emptyManifest?'an empty MPD does not disable observed continuous ad compensation':'DOM-only advertising resumes without accumulated subtitle drift',!p.state.adActive&&Math.abs(p.contentTimeMs()-10401)<.001&&p.playback.timeline.breaks().length===1);
}

prepare();markerParent.hidden=false;markerParent.style.display='none';marker.textContent='Ad';at(9);
check('an ad template inside a display-hidden ancestor does not freeze programme playback',!p.state.adActive&&!p.hasAdIndicator());
markerParent.style.display='';marker.textContent='   ';at(9.1);
check('an empty visible countdown template does not falsely signal advertising',!p.state.adActive&&!p.hasAdIndicator());
marker.textContent='Ad';markerParent.style.opacity='0';at(9.2);
check('an opacity-hidden ancestor does not falsely signal advertising',!p.state.adActive&&!p.hasAdIndicator());
markerParent.style.opacity='';markerParent.setAttribute('aria-hidden','true');at(9.3);
check('a visible ad timer still signals advertising when excluded from the accessibility tree',p.state.adActive&&p.hasAdIndicator());
markerParent.removeAttribute('aria-hidden');markerParent.hidden=true;
const hiddenVideo=document.createElement('video');hiddenVideo.style.cssText='width:3000px;height:2000px';markerParent.append(hiddenVideo);
check('a larger hidden ad video is not selected as the content clock',p.videoEl()===v);hiddenVideo.remove();

prepare();p.state.cues=[];p.state.native=[];p.renderPanel();p.renderCurrent();showMarker();
await post({type:'LM_TRACK',role:'content',lang:'en',text:'WEBVTT\\n\\n00:00.000 --> 00:05.000\\nProgramme subtitles received during pre-roll.'});
check('a programme track arriving during pre-roll is queued without being displayed',p.state.cues.length===0&&p.playback.pendingTrack?.text.includes('Programme subtitles'));
await post({type:'LM_TRACK',lang:'en',text:'WEBVTT\\n\\n00:00.000 --> 00:05.000\\nAn advertisement'});
at(15);at(30);hideMarker();at(30.401,30401);await settle();
check('the queued programme track survives ad tracks and takes effect when pre-roll ends',!p.state.adActive&&p.state.cues[0]?.text==='Programme subtitles received during pre-roll.'&&p.state.fullTrack&&p.state.activeIndex===0);
check('the restored programme caption is visible in the real DOM',p.ui.learningLine.textContent==='Programme subtitles received during pre-roll.'&&getComputedStyle(p.ui.learningLine).display!=='none');
`;

test("real Chrome Prime advertising preserves content time, subtitle visibility and queued programme tracks", { timeout: 60000 }, (t) => {
  if (!chrome) return t.skip("Set CHROME_PATH to enable the real Chrome Prime advertising checks");
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "linguamate-prime-ad-browser-"));
  try {
    const content = source("src/content/prime.js").replace(/\s+boot\(\);\s*\}\)\(\);\s*$/, "\nwindow.prime={state,ui,playback,mount,renderPanel,renderCurrent,onTick,seekTo,syncSettings,contentTimeMs,hasAdIndicator,videoEl};\n})();");
    const screenshotSetup = process.env.LM_PRIME_AD_SCREENSHOT ? `at(1,1000);showMarker();` : "";
    const finish = `(async()=>{try{${checks}${screenshotSetup}document.title='LM_PRIME_AD_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:true,checks:fixtureChecks}))));}catch(error){document.title='LM_PRIME_AD_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:false,error:error.stack,checks:fixtureChecks}))));}})();`;
    const scripts = [bridge, ...["defaults", "frequency", "captions", "feedback", "japanese", "japanese-ui", "japanese-client", "vocab-button", "prime-manifest", "prime-timeline"].map((name) => source(`src/shared/${name}.js`)), content, finish];
    const file = path.join(directory, "prime.html");
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pending</title><style>body{margin:0;background:#111;color:#fff;font:16px sans-serif}video{width:800px;height:450px;background:#152133}.atvwebplayersdk-captions-overlay{position:absolute;left:70px;top:390px;color:#fff}.fixture-player-label{position:absolute;left:40px;top:120px;color:#8ca4be;font-size:26px}${source("src/content/youtube.css")}${source("src/content/prime.css")}</style><video></video><div class="fixture-player-label">Prime Video · 播放器广告测试</div><div class="atvwebplayersdk-captions-overlay">Native player caption</div><div id="ad-marker" hidden><span class="atvwebplayersdk-adtimeindicator-text">Ad 0:30</span></div>${scripts.map((script) => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`, "utf8");
    const args = ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1280,900", "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href];
    const output = execFileSync(chrome, args, { encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const encoded = output.match(/<title>LM_PRIME_AD_RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Chrome did not complete its Prime advertising checks: ${output.slice(0, 300)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    assert.ok(result.checks.length >= 30, `Only ${result.checks.length} browser assertions completed`);
    t.diagnostic(`${result.checks.length} real Chrome DOM and media interaction assertions passed`);
    if (process.env.LM_PRIME_AD_SCREENSHOT) {
      // Freeze the verified DOM after all asynchronous postMessage work before
      // capture so headless screenshots cannot race the final status update.
      const snapshot = path.join(directory, "snapshot.html");
      fs.writeFileSync(snapshot, output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""), "utf8");
      execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "snapshot-profile")}`, "--window-size=1280,900", "--virtual-time-budget=1000", `--screenshot=${path.resolve(process.env.LM_PRIME_AD_SCREENSHOT)}`, pathToFileURL(snapshot).href], { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
  } finally {
    if (path.dirname(path.resolve(directory)) === temporaryRoot && path.basename(directory).startsWith("linguamate-prime-ad-browser-")) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
