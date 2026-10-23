const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(source("manifest.json"));
const primeContent = manifest.content_scripts.find((entry) => entry.world !== "MAIN" && entry.js.includes("src/content/prime.js"));
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));

// These fixtures run every shipping content dependency in manifest order, with
// the original boot() invocation and real intervals. In particular, they do not
// export private functions or manually call mount() as the ad-clock tests do.
// aria-hidden affects accessibility, and does not make a rendered video hidden.
for (const scenario of ["video-aria-hidden", "ancestor-aria-hidden", "track-before-video"]) {
  test(`real Chrome Prime startup: ${scenario}`, { timeout: 45000 }, (t) => {
    if (!chrome) return t.skip("Set CHROME_PATH to enable Prime startup browser checks");
    assert.ok(primeContent, "The manifest must install the Prime content script and its dependencies");
    const temporaryRoot = path.resolve(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporaryRoot, "linguamate-prime-startup-"));
    try {
      const bridge = `
        window.fixtureScenario=${JSON.stringify(scenario)};
        window.fixtureErrors=[];window.fixtureRequests=[];window.fixtureChecks=[];window.fixtureEarlyKeys=[];
        window.addEventListener('error',event=>{fixtureErrors.push(String(event.error?.stack||event.message));event.preventDefault();});
        window.addEventListener('unhandledrejection',event=>{fixtureErrors.push(String(event.reason?.stack||event.reason));event.preventDefault();});
        window.chrome={runtime:{id:'prime-startup-browser',sendMessage(message,callback){
          fixtureRequests.push(message);
          if(message.type==='LM_GET_SETTINGS')callback({ok:true,settings:{enabled:true,panelOpen:true,learningLang:'en',nativeLang:'zh-CN',showLearning:true,showNative:false}});
          else if(message.type==='LM_VOCAB_LIST')callback({ok:true,vocab:[],known:{}});
          else if(message.type==='LM_TRANSLATE')callback({ok:true,result:{text:message.text}});
          else callback({ok:true});
        }},storage:{local:{get(_key,callback){callback({});},set(){}},onChanged:{addListener(){}}}};
        window.createFixtureVideo=()=>{
          const holder=document.createElement('div');holder.id='fixture-player';
          if(fixtureScenario==='ancestor-aria-hidden')holder.setAttribute('aria-hidden','true');
          const video=document.createElement('video');
          if(fixtureScenario!=='ancestor-aria-hidden')video.setAttribute('aria-hidden','true');
          Object.defineProperties(video,{
            currentTime:{value:1,writable:true,configurable:true},
            currentSrc:{value:'blob:programme',configurable:true},
            duration:{value:600,configurable:true},
            paused:{value:true,writable:true,configurable:true},
            seeking:{value:false,configurable:true},
            textTracks:{value:[],configurable:true}
          });
          video.play=()=>Promise.resolve();video.pause=()=>{};
          holder.append(video);document.body.append(holder);window.fixtureVideo=video;
        };
        if(fixtureScenario!=='track-before-video')createFixtureVideo();
      `;
      const checks = `
        const check=(label,passed)=>{if(!passed)throw Error(label);fixtureChecks.push(label);};
        const track={source:'linguamate-prime',type:'LM_TRACK',role:'content',lang:'en',text:'WEBVTT\\n\\n00:00.000 --> 00:10.000\\nProgramme subtitles survive startup.'};
        setTimeout(()=>{
          if(fixtureScenario==='track-before-video')fixtureChecks.push(document.querySelector('video')?'unexpected early video':'track arrived before video');
          window.postMessage(track,'*');
        },30);
        if(fixtureScenario==='track-before-video')setTimeout(()=>{
          for(const key of ['a','s','d']){
            const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
            document.dispatchEvent(event);fixtureEarlyKeys.push({key,prevented:event.defaultPrevented});
          }
        },100);
        if(fixtureScenario==='track-before-video')setTimeout(createFixtureVideo,200);
        setTimeout(()=>{
          try{
            check('startup does not throw errors or unhandled promise rejections',fixtureErrors.length===0);
            check('real boot reads settings and vocabulary',fixtureRequests.some(row=>row.type==='LM_GET_SETTINGS')&&fixtureRequests.some(row=>row.type==='LM_VOCAB_LIST'));
            check('boot executed the shipping content script',window.__linguaMatePrimeUi===true);
            check('the accessibility-hidden video is still visually rendered',fixtureVideo.getBoundingClientRect().width===800&&getComputedStyle(fixtureVideo).visibility==='visible');
            const root=document.querySelector('#lm-root'),panel=document.querySelector('.lm-prime-panel'),toolbar=document.querySelector('.lm-prime-toolbar');
            check('boot mounts the subtitle overlay',!!root&&getComputedStyle(root).display!=='none');
            check('boot mounts the transcript panel',!!panel&&getComputedStyle(panel).display!=='none');
            check('boot mounts the toolbar',!!toolbar&&getComputedStyle(toolbar).display!=='none');
            check('the early track is retained and rendered after mounting',panel.querySelectorAll('.lm-cue').length===1&&panel.textContent.includes('Programme subtitles survive startup.'));
            check('real playback timer activates the retained cue',document.querySelector('#lm-learning-line')?.textContent==='Programme subtitles survive startup.');
            if(fixtureScenario==='track-before-video'){
              check('the network-first fixture actually preceded creation of the player',fixtureChecks.includes('track arrived before video'));
              check('shortcuts wait until the interface is ready',fixtureEarlyKeys.length===3&&fixtureEarlyKeys.every(event=>!event.prevented));
            }
            document.title='LM_PRIME_STARTUP_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:true,checks:fixtureChecks,errors:fixtureErrors}))));
          }catch(error){
            document.title='LM_PRIME_STARTUP_RESULT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:false,error:error.stack,checks:fixtureChecks,errors:fixtureErrors}))));
          }
        },1800);
      `;
      const scripts = [bridge, ...primeContent.js.map(source), checks];
      const file = path.join(directory, "startup.html");
      fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pending</title><style>body{margin:0;background:#111;color:#fff}video{display:block;width:800px;height:450px;background:#152133}${primeContent.css.map(source).join("\n")}</style><body>${scripts.map((script) => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`, "utf8");
      const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1280,900", "--virtual-time-budget=2500", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const encoded = output.match(/<title>LM_PRIME_STARTUP_RESULT:([^<]+)<\/title>/)?.[1];
      assert.ok(encoded, `Chrome did not complete the startup fixture: ${output.slice(0, 300)}`);
      const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.equal(result.passed, true, JSON.stringify(result, null, 2));
      assert.ok(result.checks.length >= 9);
      t.diagnostic(`${result.checks.length} real boot and DOM assertions passed`);
    } finally {
      if (path.dirname(path.resolve(directory)) === temporaryRoot && path.basename(directory).startsWith("linguamate-prime-startup-")) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
