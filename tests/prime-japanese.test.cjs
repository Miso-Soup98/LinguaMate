const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { primeHarness } = require("./prime-harness.cjs");
const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const word = { surface: "食べませんでした", lemma: "食べる", reading: "たべませんでした", baseReading: "たべる", pos: "動詞", conjugation: { type: "一段", form: "連用形", labels: ["礼貌体", "否定", "过去"] }, isWordLike: true };
const tokens = [word, { surface: "。", isWordLike: false }];
const dictionary = { word: word.surface, translation: "没有吃", japanese: { ...word, entryId: "10001" }, entries: [{ pos: "verb", items: [{ definition: "to eat", gloss: "吃" }] }], dictionarySource: "JMdict（常用词） / EDRDG", dictionaryDate: "2026-10-22", translationSource: "在线翻译" };

async function japaneseHarness(options = {}) {
  const h = primeHarness({ settings: { learningLang: "ja", japaneseFurigana: "unknown" }, japaneseTokens: tokens, lookupResult: dictionary, ...options });
  h.prime.state.cues = [{ start: 0, end: 3000, text: word.surface + "。" }];
  h.prime.state.trackLang = "ja";
  h.video.currentTime = 0.5;
  h.prime.renderPanel(); h.prime.renderCurrent(); await h.flush();
  return h;
}

test("Prime uses analyzed Japanese units, complete readings and explicit morphology in its cards", async () => {
  const h = await japaneseHarness();
  const anchor = h.prime.ui.learningLine.querySelector(".lm-word");
  assert.equal(anchor.dataset.word, word.surface);
  assert.equal(anchor.dataset.lemma, "食べる");
  assert.equal(anchor.querySelector("rt").textContent, word.reading);
  assert.equal(h.requests.filter((message) => message.type === "LM_JA_ANALYZE").length, 1, "overlay and transcript share one analysis request");
  await h.prime.showDict(anchor);
  assert.equal(h.lookupRequests()[0].japanese.lemma, "食べる");
  for (const expected of ["辞书形", "食べる", "礼貌体", "否定", "过去", "原文释义：to eat", "译文：吃", "JMdict", "在线翻译"]) assert.ok(h.prime.ui.dict.textContent.includes(expected), expected);
  assert.equal(h.prime.ui.dict.querySelector('[data-accent="us"]'), null);
  assert.ok(h.prime.ui.dict.querySelector('[data-accent="read"]'));
});

test("Prime dictionary saves Japanese lemmas with actual encountered forms and supports removal", async () => {
  const h = await japaneseHarness();
  await h.prime.showDict(h.prime.ui.learningLine.querySelector(".lm-word"));
  await h.prime.ui.vocabButton.ready;
  const button = h.prime.ui.dict.querySelector(".lm-dict-save");
  button.click(); await h.prime.ui.vocabButton.pending;
  assert.equal(h.vocab.length, 1);
  assert.equal(h.vocab[0].word, "食べる");
  assert.equal(h.vocab[0].japanese.surface, word.surface);
  assert.equal(h.vocab[0].japanese.baseReading, "たべる");
  assert.equal(typeof h.vocab[0].japanese.conjugation, "string");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.click(); await h.prime.ui.vocabButton.pending;
  assert.equal(h.vocab.length, 0);
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("Prime Japanese right-click saves the lemma and matching distinguishes homograph readings", async () => {
  const h = await japaneseHarness();
  const anchor = h.prime.ui.panelBody.querySelector(".lm-word");
  h.prime.ui.panel.emit("contextmenu", { target: anchor }); await h.flush(); await h.flush();
  assert.equal(h.vocab[0].word, "食べる");
  assert.equal(h.vocab[0].japanese.surface, word.surface);
  h.prime.state.vocab = [{ word: "生", lang: "ja", japanese: { lemma: "生", baseReading: "なま" } }];
  assert.equal(h.prime.isSavedJapanese({ surface: "生", lemma: "生", baseReading: "ナマ" }), true);
  assert.equal(h.prime.isSavedJapanese({ surface: "生", lemma: "生", baseReading: "せい" }), false);
});

test("Prime updates Japanese mastery and furigana preferences without conflating saved and mastered", async () => {
  const h = await japaneseHarness();
  const anchor = h.prime.ui.learningLine.querySelector(".lm-word");
  await h.storageChange({ known: { newValue: { "ja:食べる|reading=%E3%81%9F%E3%81%B9%E3%82%8B|entry=10001": true } } });
  assert.equal(anchor.classList.contains("lm-known"), true);
  assert.equal(anchor.classList.contains("lm-saved"), false);
  await h.storageChange({ known: { newValue: {} } });
  assert.equal(h.prime.ui.learningLine.querySelector(".lm-word"), anchor);
  assert.equal(anchor.classList.contains("lm-known"), false);
  h.prime.applySettings({ ...h.prime.state.settings, japaneseFurigana: "off" }); await h.flush();
  assert.equal(h.prime.ui.learningLine.querySelector("ruby"), null);
});

test("Prime Japanese rarity follows dictionary coverage and excludes grammar without guessing from word length", async () => {
  const unusual = { surface: "珍", lemma: "珍", reading: "ちん", common: false, isWordLike: true };
  const grammar = { surface: "の", lemma: "の", reading: "の", common: false, grammar: true, isWordLike: true };
  const unknown = { surface: "未収録語", lemma: "未収録語", common: null, isWordLike: true };
  const h = primeHarness({ settings: { learningLang: "ja" }, japaneseTokens: [unusual, grammar, unknown] });
  h.prime.state.cues = [{ start: 0, end: 3000, text: "珍の未収録語" }]; h.video.currentTime = .5;
  h.prime.renderCurrent(); await h.flush(); h.prime.syncWordMarkers();
  const words = h.prime.ui.learningLine.querySelectorAll(".lm-word");
  assert.equal(words[0].classList.contains("lm-rare"), true, "a one-character word can be uncommon");
  assert.equal(words[1].classList.contains("lm-rare"), false);
  assert.equal(words[2].classList.contains("lm-rare"), false, "missing dictionary coverage is not a guessed word-length level");
});

test("Prime keeps regional Japanese track metadata while normalizing lookup and saved vocabulary to ja", async () => {
  const h = await japaneseHarness();
  h.prime.state.trackLang = "ja-JP";
  h.prime.ui.learningLine._lmWordsKey = null;
  h.prime.renderCurrent(); await h.flush();
  const anchor = h.prime.ui.learningLine.querySelector(".lm-word");
  assert.equal(h.prime.state.trackLang, "ja-JP");
  assert.equal(anchor.dataset.lang, "ja");
  await h.prime.showDict(anchor); await h.prime.ui.vocabButton.ready;
  assert.equal(h.lookupRequests().at(-1).from, "ja");
  h.prime.ui.dict.querySelector(".lm-dict-save").click(); await h.prime.ui.vocabButton.pending;
  assert.equal(h.vocab[0].lang, "ja");
});

test("Prime Japanese word cards, saved forms and explicit phrase queries work in real Chrome", { timeout: 45000 }, (t) => {
  const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));
  if (!chrome) return t.skip("Set CHROME_PATH for the Chrome Japanese integration check");
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "linguamate-prime-japanese-"));
  const bridge = `
    window.fixtureVocab=[];window.fixtureRequests=[];window.fixtureChecks=[];
    window.setInterval=()=>0;
    window.chrome={runtime:{id:'prime-japanese-test',sendMessage(message,callback){
      fixtureRequests.push(message);
      if(message.type==='LM_JA_ANALYZE')callback({ok:true,tokens: message.text===${JSON.stringify(word.surface + "。")} ? ${JSON.stringify(tokens)} : [{surface:message.text,lemma:message.text,isWordLike:true}]});
      else if(message.type==='LM_LOOKUP')callback({ok:true,result:message.japanese?.isPhrase?{word:message.word,translation:'词组译文',japanese:{surface:message.word,lemma:message.word,pos:'短语 / 选区'}}:${JSON.stringify(dictionary)}});
      else if(message.type==='LM_VOCAB_LIST')callback({ok:true,vocab:fixtureVocab,known:{}});
      else if(message.type==='LM_VOCAB_ADD'){const item={...message.item,id:'confirmed-japanese'};fixtureVocab.push(item);callback({ok:true,item});}
      else if(message.type==='LM_VOCAB_DELETE'){fixtureVocab=fixtureVocab.filter(item=>item.id!==message.id);callback({ok:true});}
      else callback({ok:true});
    }},storage:{local:{get(_key,callback){callback({});},set(){}},onChanged:{addListener(){}}}};
    window.check=(value,label)=>{if(!value)throw new Error(label);fixtureChecks.push(label);};
    window.settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
  `;
  const content = source("src/content/prime.js").replace(/\s+boot\(\);\s*\}\)\(\);\s*$/, "\nwindow.prime={state,ui,mount,renderPanel,renderCurrent,showDict,hideDict,onPhraseSelection,applySettings};\n})();");
  const checks = `
    const p=prime,video=document.querySelector('video');
    p.state.settings={...p.state.settings,learningLang:'ja',japaneseFurigana:'unknown'};p.state.trackLang='ja';
    p.mount();p.state.cues=[{start:0,end:3000,text:${JSON.stringify(word.surface + "。")}}];video.currentTime=.5;p.renderPanel();p.renderCurrent();await settle();
    p.ui.panelBody.querySelector('.lm-cue-learning').dispatchEvent(new Event('mouseenter'));await settle();
    let anchor=p.ui.learningLine.querySelector('.lm-word');
    check(anchor.dataset.word===${JSON.stringify(word.surface)}&&anchor.dataset.lemma==='食べる','analyzed word keeps surface and lemma separately');
    check(anchor.querySelector('rt').textContent===${JSON.stringify(word.reading)},'ruby contains the actual complete reading');
    check(parseFloat(getComputedStyle(p.ui.panelBody.querySelector('rt')).fontSize)>=9,'sidebar readings remain at least nine pixels');
    check(p.ui.panelBody.scrollWidth<=p.ui.panelBody.clientWidth,'Japanese transcript rows do not create a horizontal scrollbar');
    await p.showDict(anchor);await p.ui.vocabButton.ready;
    check(p.ui.dict.textContent.includes('辞书形')&&p.ui.dict.textContent.includes('原文释义：to eat'),'Japanese card distinguishes morphology and dictionary definition');
    let button=p.ui.dict.querySelector('.lm-dict-save');button.click();await p.ui.vocabButton.pending;
    check(fixtureVocab.length===1&&fixtureVocab[0].word==='食べる'&&fixtureVocab[0].japanese.surface===${JSON.stringify(word.surface)},'save groups an inflected form under its lemma');
    button.click();await p.ui.vocabButton.pending;check(fixtureVocab.length===0,'second click removes the confirmed Japanese entry');
    p.hideDict();
    const next=document.createElement('span');next.className='lm-word lm-ja-word';next.dataset.word='から';next.dataset.surface='から';next.dataset.lang='ja';next.textContent='から';anchor.after(next);
    const range=document.createRange();range.setStart(anchor.querySelector('ruby').firstChild,0);range.setEnd(next.firstChild,2);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    const lookupsBefore=fixtureRequests.filter(message=>message.type==='LM_LOOKUP').length;
    p.onPhraseSelection({target:next});
    check(p.ui.phraseButton.hidden===false,'selecting a range exposes an explicit phrase action');
    check(fixtureRequests.filter(message=>message.type==='LM_LOOKUP').length===lookupsBefore,'selecting text alone does not open flashing cards');
    p.ui.phraseButton.click();await settle();
    const lookup=fixtureRequests.filter(message=>message.type==='LM_LOOKUP').at(-1);
    check(lookup.word===${JSON.stringify(word.surface + "から")}&&lookup.japanese.isPhrase===true,'phrase request excludes all ruby readings');
    p.hideDict();selection.removeAllRanges();p.applySettings({...p.state.settings,japaneseFurigana:'off'});await settle();
    check(!p.ui.learningLine.querySelector('ruby'),'furigana preference changes apply to Prime immediately');
  `;
  const screenshotSetup = process.env.LM_PRIME_JA_SCREENSHOT ? `p.applySettings({...p.state.settings,japaneseFurigana:'all'});await settle();await new Promise(resolve=>setTimeout(resolve,600));await p.showDict(p.ui.learningLine.querySelector('.lm-word'));await p.ui.vocabButton.ready;` : "";
  const finish = `(async()=>{try{${checks}${screenshotSetup}document.title='LM_PRIME_JAPANESE:ok';}catch(error){document.title='LM_PRIME_JAPANESE:'+btoa(unescape(encodeURIComponent(error.stack)));}})();`;
  const scripts = [bridge, ...["defaults", "frequency", "captions", "feedback", "japanese", "japanese-ui", "japanese-client", "vocab-button"].map((name) => source(`src/shared/${name}.js`)), content, finish];
  const file = path.join(directory, "prime.html");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pending</title><style>body{margin:0;background:#111}video{width:800px;height:450px}${source("src/content/youtube.css")}${source("src/content/prime.css")}</style><video></video>${scripts.map((script) => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`, "utf8");
  try {
    const screenshot = process.env.LM_PRIME_JA_SCREENSHOT ? [`--screenshot=${path.resolve(process.env.LM_PRIME_JA_SCREENSHOT)}`] : [];
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1280,900", "--virtual-time-budget=3000", ...screenshot, "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (process.env.LM_PRIME_JA_SCREENSHOT) {
      // Headless screenshot capture can precede the final asynchronous card
      // update. Freeze the verified DOM for stable visual QA of that state.
      const snapshot = path.join(directory, "snapshot.html");
      fs.writeFileSync(snapshot, output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""), "utf8");
      execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "snapshot-profile")}`, "--window-size=1280,900", "--virtual-time-budget=1000", ...screenshot, pathToFileURL(snapshot).href], { encoding: "utf8", timeout: 35000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    const result = output.match(/<title>LM_PRIME_JAPANESE:([^<]+)<\/title>/)?.[1];
    assert.ok(result, `Chrome did not finish Japanese Prime checks: ${output.slice(0, 200)}`);
    assert.equal(result, "ok", result === "ok" ? "" : Buffer.from(result, "base64").toString("utf8"));
  } finally {
    if (path.dirname(path.resolve(directory)) === temporaryRoot && path.basename(directory).startsWith("linguamate-prime-japanese-")) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
