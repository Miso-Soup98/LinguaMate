const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));
const shippingHook = fs.readFileSync(path.join(root, "src/injected/prime.js"), "utf8");
const manifestParser = fs.readFileSync(path.join(root, "src/shared/prime-manifest.js"), "utf8");
const hook = shippingHook.replace(/\nlinguaMateInstallPrimeHook\(\);\s*$/, "");

const checks = String.raw`
const posts = [], resources = new Map(), requests = [];
const originalResponseText = '<tt xml:lang="en"><body><p begin="0s" end="3s">programme subtitle</p></body></tt>';
let returnedPromise;
window.postMessage = (message) => posts.push(message);
window.fetch = function(input,init) {
 const url=typeof input==='string'?input:input.url;
 requests.push({url,init});
 const resource=resources.get(url);
 if(!resource) throw new Error('Unexpected fetch '+url);
 const makeResponse=()=>new Response(resource.text,{headers:{'Content-Type':resource.type||'application/dash+xml'}});
 returnedPromise=resource.delay?new Promise(resolve=>{resource.release=()=>resolve(makeResponse());}):Promise.resolve(makeResponse());
 return returnedPromise;
};
class FixtureXHR extends EventTarget {
 open(method,url){this.method=method;this.url=url;return 'open unchanged';}
 send(body){this.sentBody=body;return 'send unchanged';}
 getResponseHeader(name){return name==='content-type'?this.contentType||'application/dash+xml':null;}
 complete(text,type=''){this.responseType=type;this.responseText=text;this.response=type==='arraybuffer'?new TextEncoder().encode(text).buffer:type==='blob'?new Blob([text]):text;this.dispatchEvent(new Event('load'));}
}
window.XMLHttpRequest=FixtureXHR;
linguaMateInstallPrimeHook();
const results=[];
function check(name,passed){if(!passed)throw new Error(name);results.push(name);}
async function settle(){for(let i=0;i<50;i++)await Promise.resolve();await new Promise(resolve=>setTimeout(resolve,20));}
function timelines(){return posts.filter(message=>message.type==='LM_PRIME_TIMELINE');}
function currentScope(){const url=new URL(location.href);return url.pathname+['gti','titleId','asin'].map(key=>'|'+key+'='+(url.searchParams.get(key)||'')).join('');}
function moveTo(title){history.replaceState(null,'',location.pathname+'?titleId='+title);}
function pull(){window.dispatchEvent(new MessageEvent('message',{source:window,data:{source:'linguamate-content',type:'LM_PRIME_PULL',lang:'en'}}));}
async function manifest(text,url='https://video.example/fixture.mpd',type='application/dash+xml'){
 resources.set(url,{text,type});const promise=fetch(url);check('fetch keeps the original promise',promise===returnedPromise);
 const response=await promise;const body=await response.text();await settle();
 check('fetch leaves the player response intact',body===text);return timelines().at(-1);
}
const mpd=(periods,attributes='mediaPresentationDuration="PT2M"')=>'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" '+attributes+'>'+periods+'</MPD>';
await manifest(mpd('<Period duration="PT30S"/><Period start="PT30S" duration="PT15S"><SupplementalProperty value="Ad"/></Period><Period start="PT45S"/>'));
check('MPD advert descriptor creates the exact millisecond range',JSON.stringify(timelines().at(-1).breaks)==='[{"start":30000,"end":45000}]');
check('MPD source URL is retained',timelines().at(-1).url==='https://video.example/fixture.mpd');
check('MPD carries the current programme scope and full duration',timelines().at(-1).scope===currentScope()&&timelines().at(-1).duration===120000&&timelines().at(-1).end===120000&&timelines().at(-1).role==='content');
check('MPD is never published as a subtitle track',posts.every(message=>message.type!=='LM_TRACK'));
const earlyTimeline=timelines().at(-1);const earlyCount=timelines().length;pull();await settle();
check('the first content pull replays a manifest captured before listener startup',timelines().length===earlyCount+1&&JSON.stringify(timelines().at(-1))===JSON.stringify(earlyTimeline));
await manifest(mpd('<Period duration="PT1M0.25S"/><Period duration="PT0.5S"><EssentialProperty value="Draper"/></Period><Period/>','mediaPresentationDuration="PT1H2M3.5S"'));
check('omitted starts use the previous period duration with fractional seconds',JSON.stringify(timelines().at(-1).breaks)==='[{"start":60250,"end":60750}]');
await manifest(mpd('<Period start="PT0S"/><Period start="PT30S"><AdaptationSet><BaseURL>https://video.example/interstitial/123/</BaseURL></AdaptationSet></Period><Period start="PT45S"/>'));
check('interstitial BaseURL uses the next explicit period boundary',JSON.stringify(timelines().at(-1).breaks)==='[{"start":30000,"end":45000}]');
await manifest(mpd('<Period duration="PT1M"/><Period><Descriptor value="Ad"/></Period>'));
check('the final ad ends at the presentation duration',JSON.stringify(timelines().at(-1).breaks)==='[{"start":60000,"end":120000}]');
await manifest(mpd('<Period><Role value="adaptation"/></Period>'),'https://video.example/manifest-no-extension');
check('the DASH content type is inspected without a URL extension',timelines().at(-1).breaks.length===0);
await manifest(mpd('<Period><SupplementalProperty value="Adaptation"/></Period>'),'https://video.example/manifest.mpd?token=fixture','application/octet-stream');
check('non-ad descriptor values do not count as adverts',timelines().at(-1).breaks.length===0);
const invalid=[
 mpd('<Period/><Period duration="PT15S"><Role value="Ad"/></Period>'),
 mpd('<Period duration="PT10S"/><Period><Role value="Ad"/></Period>',''),
 mpd('<Period start="PT10S" duration="PT10S"><Role value="Ad"/></Period>'),
 mpd('<Period duration="PT20S"/><Period start="PT10S"><Role value="Ad"/></Period>'),
 mpd('<Period duration="bad"/><Period start="PT10S"><Role value="Ad"/></Period>'),
 mpd('<Period><Role value="Ad"/></Period>'),
 mpd('<Period><Role value="Ad"/></Period>','type="dynamic" mediaPresentationDuration="PT2M"'),
 '<MPD><Period><Role value="Ad"></Period></MPD>',
 '<!DOCTYPE MPD [<!ENTITY x "ignored">]>'+mpd('<Period><Role value="Ad"/></Period>')
];
for(const text of invalid){const count=timelines().length;await manifest(text);check('incomplete or contradictory MPDs do not replace a trusted clock',timelines().length===count);}
const xhr=new XMLHttpRequest();check('XHR open return is unchanged',xhr.open('GET','https://video.example/xhr.mpd')==='open unchanged');
check('XHR send return and request body are unchanged',xhr.send('original-body')==='send unchanged'&&xhr.sentBody==='original-body');
const xhrBody=mpd('<Period duration="PT30S"/><Period duration="PT15S"><Role value="Ad"/></Period><Period/>');
xhr.complete(xhrBody,'arraybuffer');await settle();
check('arraybuffer XHR manifests publish a timeline',timelines().at(-1).url==='https://video.example/xhr.mpd'&&timelines().at(-1).breaks[0].start===30000);
check('XHR preserves its response',new TextDecoder().decode(xhr.response)===xhrBody&&xhr.responseType==='arraybuffer');
const blobXhr=new XMLHttpRequest();blobXhr.open('GET','https://video.example/blob.mpd');blobXhr.send();blobXhr.complete(xhrBody,'blob');await settle();
for(let i=0;i<50&&timelines().at(-1).url!=='https://video.example/blob.mpd';i++)await new Promise(resolve=>setTimeout(resolve,10));
check('blob XHR manifests are inspected without replacing the blob',timelines().at(-1).url==='https://video.example/blob.mpd'&&blobXhr.response instanceof Blob);
const trackUrl='https://video.example/programme.ttml',adTrack='https://video.example/advert.ttml';
resources.set(trackUrl,{text:originalResponseText,type:'application/ttml+xml'});resources.set(adTrack,{text:originalResponseText.replace('programme','advert'),type:'application/ttml+xml'});
const playbackUrl='https://video.example/GetPlaybackResources';
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:trackUrl,languageCode:'en'}]}),type:'application/json'});
await fetch(playbackUrl);await settle();
check('tracks from programme resources carry the content role',posts.some(message=>message.type==='LM_TRACK'&&message.url===trackUrl&&message.role==='content'));
check('tracks retain their request programme scope',posts.filter(message=>message.type==='LM_TRACK').every(message=>message.scope===currentScope()));
const programmeBeforeAds=timelines().at(-1);
// Captured from the current Amazon Japan player: the countdown is the only
// stable SDK class; neither parent has the older exact ad-timer class.
const container=document.createElement('div');container.className='fixture-random-ad-parent';container.setAttribute('aria-label','広告を再生しています。コンテンツは、1分48秒後に再開されます。');container.innerHTML='<div class="fixture-random-ad-inner"><span class="atvwebplayersdk-ad-timer-remaining-time">1:48</span></div>';document.body.append(container);
const trustedCount=timelines().length;
await manifest(mpd('<Period/>','mediaPresentationDuration="PT30S"'),'https://video.example/standalone-ad.mpd');
check('the current Amazon Japan countdown prevents an unmarked standalone ad MPD from erasing the programme timeline',timelines().length===trustedCount);
await manifest(mpd('<Period><Role value="Ad"/></Period>','mediaPresentationDuration="PT30S"'),'https://video.example/marked-ad.mpd');
check('an all-ad MPD cannot replace the programme timeline',timelines().length===trustedCount);
await manifest(mpd('<Period duration="PT30S"><Role value="Ad"/></Period><Period/>'),'https://video.example/full-presentation.mpd');
check('a complete mixed programme manifest remains usable during pre-roll',timelines().length===trustedCount+1&&timelines().at(-1).duration===120000);
pull();await settle();
check('ad-time manifests do not replace an existing cached programme timeline',JSON.stringify(timelines().at(-1))===JSON.stringify(programmeBeforeAds));
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:adTrack,languageCode:'en'}]}),type:'application/json'});
await fetch(playbackUrl);await settle();
check('the current Amazon Japan countdown prevents ad resources from overwriting programme tracks',!requests.some(request=>request.url===adTrack));
pull();await settle();
check('a pull during an advert still uses the cached programme track',requests.at(-1).url===trackUrl);
container.style.display='none';await fetch(playbackUrl);await settle();
check('a hidden ancestor does not falsely signal an advert',requests.some(request=>request.url===adTrack));
container.style.display='';container.querySelector('span').textContent='';
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:trackUrl,languageCode:'en'}]}),type:'application/json'});
let before=requests.filter(request=>request.url===trackUrl).length;await fetch(playbackUrl);await settle();
check('an empty advert template does not discard programme resources',requests.filter(request=>request.url===trackUrl).length===before+1);
container.querySelector('span').textContent='Ad';container.style.opacity='0';
before=requests.filter(request=>request.url===trackUrl).length;await fetch(playbackUrl);await settle();
check('an opacity-hidden ancestor does not signal an advert',requests.filter(request=>request.url===trackUrl).length===before+1);
container.style.opacity='';container.querySelector('span').className='atvwebplayersdk-ad-timer';
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:adTrack,languageCode:'en'}]}),type:'application/json'});
before=requests.filter(request=>request.url===adTrack).length;await fetch(playbackUrl);await settle();
check('the alternate visible advert timer also protects programme tracks',requests.filter(request=>request.url===adTrack).length===before);
container.querySelector('span').className='atvwebplayersdk-adtimeindicator-text';
before=requests.filter(request=>request.url===adTrack).length;await fetch(playbackUrl);await settle();
check('the legacy adtimeindicator text still protects programme tracks',requests.filter(request=>request.url===adTrack).length===before);
container.querySelector('span').className='atvwebplayersdk-ad-timer-remaining-time';container.querySelector('span').textContent='1:48';
const lateAdUrl='https://video.example/late-ad.mpd';resources.set(lateAdUrl,{text:mpd('<Period/>','mediaPresentationDuration="PT30S"'),delay:true});
const delayedAd=fetch(lateAdUrl);const beforeLateAd=timelines().length;container.style.display='none';resources.get(lateAdUrl).release();await delayedAd;await settle();
check('an unmarked ad MPD requested during ads remains ignored after its delayed response',timelines().length===beforeLateAd);
// Responses belong to the page on which their requests began, including old
// requests that only finish after the SPA has moved to another episode.
container.style.display='none';
const lateUrl='https://video.example/late-old.mpd',lateTrack='https://video.example/late-old.ttml';
resources.set(lateUrl,{text:xhrBody,delay:true});resources.set(lateTrack,{text:originalResponseText,type:'application/ttml+xml',delay:true});
const oldManifest=fetch(lateUrl),oldTrack=fetch(lateTrack);
const oldXhr=new XMLHttpRequest();oldXhr.open('GET','https://video.example/old-xhr.mpd');oldXhr.send();
const originalInit={method:'POST',body:JSON.stringify({globalParameters:{playbackEnvelope:'old-envelope'}})};
await fetch(playbackUrl,originalInit);await settle();
check('fetch forwards the original request options by identity',requests.findLast(request=>request.url===playbackUrl).init===originalInit);
moveTo('second-programme');before=requests.length;pull();await settle();
check('a programme switch clears the cached track list and playback envelope',requests.length===before);
check('a programme switch also clears the cached timeline message',!posts.some(message=>message.scope===currentScope()));
resources.get(lateUrl).release();resources.get(lateTrack).release();await Promise.all([oldManifest,oldTrack]);oldXhr.complete(xhrBody);await settle();
check('late fetch and XHR responses from the old programme are ignored',!posts.some(message=>message.url===lateUrl||message.url===lateTrack||message.url==='https://video.example/old-xhr.mpd'));
await manifest(xhrBody,'https://video.example/new-programme.mpd');
check('the new programme manifest carries the new scope',timelines().at(-1).scope===currentScope());
// The first programme resource response often arrives before pre-roll ends.
moveTo('preroll-programme');container.style.display='';container.querySelector('span').className='atvwebplayersdk-ad-timer-remaining-time';container.querySelector('span').textContent='1:48';
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:trackUrl,languageCode:'en'}]}),type:'application/json'});
before=requests.filter(request=>request.url===trackUrl).length;await fetch(playbackUrl);await settle();pull();await settle();
check('the first pre-roll programme candidate is retained without fetching it during ads',requests.filter(request=>request.url===trackUrl).length===before);
resources.set(playbackUrl,{text:JSON.stringify({subtitleUrls:[{url:adTrack,languageCode:'en'}]}),type:'application/json'});
await fetch(playbackUrl);await settle();container.style.display='none';pull();await settle();
check('the first candidate survives later ad resources and loads after pre-roll without an envelope',requests.filter(request=>request.url===trackUrl).length===before+1&&posts.at(-1).url===trackUrl&&posts.at(-1).scope===currentScope());
moveTo('envelope-programme');resources.set(playbackUrl,{text:'{}',type:'application/json'});
await fetch(playbackUrl,{method:'POST',body:JSON.stringify({globalParameters:{playbackEnvelope:'new-envelope'}})});await settle();before=requests.length;pull();await settle();
check('scope reset preserves the new request envelope for a later subtitle pull',requests.length===before+1&&JSON.parse(requests.at(-1).init.body).globalParameters.playbackEnvelope==='new-envelope');
document.title='LM_HOOK_RESULT:'+btoa(JSON.stringify({passed:true,checks:results}));
`;

test("Prime network hook reads MPD ad boundaries without changing playback responses", { timeout: 45000 }, (t) => {
  if (!chrome) return t.skip("Set CHROME_PATH to enable browser integration tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-prime-hook-"));
  try {
    const script = `${manifestParser}\n${hook}\n(async()=>{try{${checks}}catch(error){document.title='LM_HOOK_RESULT:'+btoa(JSON.stringify({passed:false,error:error.stack}));}})();`;
    const file = path.join(directory, "hook.html");
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pending</title><body><script>${script.replace(/<\/script/gi, "<\\/script")}</script>`, "utf8");
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 35000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const encoded = output.match(/<title>LM_HOOK_RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Browser did not complete: ${output.slice(0, 300)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    assert.ok(result.checks.length >= 30);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const trustedTypes of [false, true]) test(trustedTypes ? "shipping Prime script forwards raw MPD under enforced Trusted Types" : "shipping Prime MAIN-world script observes fetch under strict script CSP", { timeout: 45000 }, (t) => {
  if (!chrome) return t.skip("Set CHROME_PATH to enable browser integration tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-prime-csp-"));
  try {
    const setup = String.raw`
      window.fixtureTrustedTypes=${trustedTypes};
      window.fixtureBody='<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT2M"><Period duration="PT30S"><Role value="Ad"/></Period><Period/></MPD>';
      window.fixtureRequests=[];
      window.fetch=function(input,init){fixtureRequests.push({input,init});return Promise.resolve(new Response(fixtureBody,{headers:{'content-type':'application/dash+xml'}}));};
      window.fixtureOriginalFetch=window.fetch;
      window.fixtureNextManifest=()=>new Promise(resolve=>window.addEventListener('message',function receive(event){if(event.source===window&&['LM_PRIME_TIMELINE','LM_PRIME_MPD'].includes(event.data?.type)){window.removeEventListener('message',receive);resolve(event.data);}}));
      window.fixtureTimeline=fixtureNextManifest();
      window.fixtureXmlBlocked=false;
      try{new DOMParser().parseFromString(fixtureBody,'application/xml');}catch(error){fixtureXmlBlocked=error instanceof TypeError;}
    `;
    const verify = String.raw`
      (async()=>{try{
        if(window.fixtureInlineExecuted)throw new Error('fixture CSP did not block inline scripts');
        if(!window.__linguaMatePrime||window.fetch===fixtureOriginalFetch)throw new Error('shipping script did not install fetch observation');
        const init={credentials:'include',headers:{'fixture':'unchanged'}};
        const response=await fetch('https://video.example/strict-csp.mpd',init);
        if(await response.text()!==fixtureBody)throw new Error('player response changed');
        const timeline=await Promise.race([fixtureTimeline,new Promise((_,reject)=>setTimeout(()=>reject(new Error('MPD was not observed')),1500))]);
        if(fixtureRequests.length!==1||fixtureRequests[0].init!==init)throw new Error('player request changed');
        if(fixtureTrustedTypes){
          if(!fixtureXmlBlocked)throw new Error('fixture did not enforce Trusted Types on DOMParser');
          if(timeline.type!=='LM_PRIME_MPD'||timeline.text!==fixtureBody||timeline.adActive!==false||timeline.role!=='content'||!timeline.scope)throw new Error('raw MPD fallback was not preserved under Trusted Types');
        }else if(timeline.type!=='LM_PRIME_TIMELINE'||timeline.breaks.length!==1||timeline.breaks[0].start!==0||timeline.breaks[0].end!==30000||timeline.duration!==120000)throw new Error('incorrect timeline under CSP');
        const replay=fixtureNextManifest();window.postMessage({source:'linguamate-content',type:'LM_PRIME_PULL',lang:'en'},'*');
        const cached=await Promise.race([replay,new Promise((_,reject)=>setTimeout(()=>reject(new Error('cached manifest was not replayed')),1500))]);
        if(JSON.stringify(cached)!==JSON.stringify(timeline))throw new Error('cached manifest replay changed its scope or contents');
        document.title='LM_CSP_RESULT:'+btoa(JSON.stringify({passed:true}));
      }catch(error){document.title='LM_CSP_RESULT:'+btoa(JSON.stringify({passed:false,error:error.stack}));}})();
    `;
    fs.writeFileSync(path.join(directory, "setup.js"), setup, "utf8");
    fs.writeFileSync(path.join(directory, "prime-manifest.js"), manifestParser, "utf8");
    fs.writeFileSync(path.join(directory, "prime.js"), shippingHook, "utf8");
    fs.writeFileSync(path.join(directory, "verify.js"), verify, "utf8");
    const file = path.join(directory, "strict-csp.html");
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' file:${trustedTypes ? "; require-trusted-types-for 'script'; trusted-types 'none'" : ""}"><title>pending</title><body><script>window.fixtureInlineExecuted=true;</script><script src="setup.js"></script><script src="prime-manifest.js"></script><script src="prime.js"></script><script src="verify.js"></script>`, "utf8");
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 35000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const encoded = output.match(/<title>LM_CSP_RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Browser did not complete the strict CSP fixture: ${output.slice(0, 500)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
