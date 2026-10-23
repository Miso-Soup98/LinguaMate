const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const root = path.resolve(__dirname, "..");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));

test("real Chrome worker imports the shipping backend and reads bundled dictionaries with fetch and gzip streams", { timeout: 45000 }, async (t) => {
  if (!chrome) return t.skip("Set CHROME_PATH for the real Chrome worker test");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-ja-worker-"));
  const worker = `
    const store={sync:{},local:{vocab:[],known:{}}};
    const area=name=>({get:async defaults=>structuredClone({...defaults,...store[name]}),set:async patch=>Object.assign(store[name],structuredClone(patch))});
    self.chrome={runtime:{getURL:filename=>new URL('/'+filename,location.href).href,onInstalled:{addListener(){}},onMessage:{addListener(){}}},
      storage:{sync:area('sync'),local:area('local')},contextMenus:{onClicked:{addListener(){}}}};
    importScripts('/src/background/service-worker.js');
    translateGoogle=async (text)=>({text:'[0] local fixture translation',senses:[]});
    translateMyMemory=async()=>({text:'fixture fallback'});
    self.onmessage=async event=>{try{self.postMessage({id:event.data.id,...await handleMessage(event.data.message)});}
      catch(error){self.postMessage({id:event.data.id,ok:false,error:error.stack});}};
  `;
  const page = `<!doctype html><meta charset="utf-8"><title>pending</title><img hidden src="/wait"><script>
    (async()=>{try{
      const worker=new Worker('/src/background/fixture.js');let sequence=0;const pending=new Map();
      worker.onmessage=event=>{pending.get(event.data.id)?.(event.data);pending.delete(event.data.id);};
      worker.onerror=error=>{document.title='RESULT:'+btoa(JSON.stringify({error:error.message}));};
      const send=message=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);worker.postMessage({id,message});});
      const check=(ok,label)=>{if(!ok)throw Error(label);};
      const analyzed=await send({type:'LM_JA_ANALYZE',text:'猫が食べませんでした。'});
      check(analyzed.ok,'worker analysis: '+analyzed.error);
      const token=analyzed.tokens.find(token=>token.surface==='食べませんでした');
      check(token?.lemma==='食べる'&&token.baseReading==='たべる','real dictionary form/reading');
      check(analyzed.tokens.find(token=>token.surface==='猫')?.common===true,'one-character common word');
      const lookup=await send({type:'LM_LOOKUP',word:token.surface,from:'ja',to:'en',context:'猫が食べませんでした。',japanese:token});
      check(lookup.ok&&lookup.result.entries.some(entry=>/eat/.test(entry.items[0].definition)),'real JMdict meanings');
      check(lookup.result.dictionaryDate===${JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, "src/vendor/jmdict/SOURCE.json"), "utf8")).dataDate)},'dictionary provenance');
      const ja=lookup.result.japanese;
      const metadata={lemma:ja.lemma,surface:ja.surface,reading:ja.reading,baseReading:ja.baseReading,pos:ja.pos,conjugation:ja.conjugation.labels.join(' · '),entryId:ja.entryId||''};
      const item={word:ja.lemma,lang:'ja',translation:lookup.result.translation,japanese:metadata,context:'猫が食べませんでした。'};
      const saved=await send({type:'LM_VOCAB_ADD',item});check(saved.ok,'save: '+saved.error);
      const again=await send({type:'LM_VOCAB_ADD',item:{...item,japanese:{...metadata,surface:'食べた'},context:'昨日食べた。'}});
      check(again.ok&&again.item.id===saved.item.id&&again.item.sourceForms.length===2,'inflections share one card and preserve source examples');
      const known=await send({type:'LM_MARK_KNOWN',word:'食べる',lang:'ja',japanese:metadata,known:true});
      check(known.ok,'known mutation');
      const exported=await send({type:'LM_DATA_EXPORT'});
      check(exported.ok&&exported.data.vocab.length===1&&exported.data.vocab[0].status==='known','round-trip Japanese progress');
      const range=await send({type:'LM_LOOKUP',word:'行かなければならない',from:'ja',to:'en',japanese:{isPhrase:true}});
      check(range.ok&&range.result.japanese.lemma==='行かなければならない'&&range.result.japanese.isPhrase,'phrase identity');
      worker.terminate();document.title='RESULT:'+btoa(JSON.stringify({ok:true,checks:8}));
    }catch(error){document.title='RESULT:'+btoa(JSON.stringify({error:error.stack}));}finally{fetch('/finish');}})();
  </script>`;
  let waiting;
  let finished = false;
  const server = http.createServer((request, response) => {
    if (request.url === "/") { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(page); return; }
    if (request.url === "/src/background/fixture.js") { response.setHeader("Content-Type", "text/javascript;charset=utf-8"); response.end(worker); return; }
    if (request.url === "/wait") { if (finished) response.end(); else waiting = response; return; }
    if (request.url === "/finish") { finished = true; waiting?.end(); response.end(); return; }
    const filename = path.resolve(root, "." + decodeURIComponent(request.url.split("?")[0]));
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", filename.endsWith(".js") ? "text/javascript;charset=utf-8" : "application/octet-stream");
    fs.createReadStream(filename).pipe(response);
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { stdout } = await run(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--virtual-time-budget=20000", "--dump-dom", `http://127.0.0.1:${server.address().port}/`],
      { encoding: "utf8", timeout: 35000, maxBuffer: 1024 * 1024, windowsHide: true });
    const encoded = stdout.match(/<title>RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Worker did not finish: ${stdout.slice(0, 300)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
