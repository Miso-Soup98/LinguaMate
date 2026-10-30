const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((name) => name && fs.existsSync(name));

test("YouTube Japanese subtitle, lookup, identity, selection, statistics and settings work in real Chrome", { timeout: 45000 }, (t) => {
  if (!chrome) return t.skip("Set CHROME_PATH to enable browser integration tests");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-youtube-japanese-"));
  try {
    const bridge = `
      window.setInterval=()=>0;
      window.fixtureData={sync:{},local:{vocab:[],known:{}}};
      window.fixtureMessages=[];
      window.fixtureChecks=[];
      window.fixtureObserved=new Set();
      const NativeIntersectionObserver=window.IntersectionObserver;
      window.IntersectionObserver=class{
        constructor(callback,options){this.delegate=new NativeIntersectionObserver(callback,options);}
        observe(target){fixtureObserved.add(target);this.delegate.observe(target);}
        unobserve(target){fixtureObserved.delete(target);this.delegate.unobserve(target);}
        disconnect(){this.delegate.disconnect();}
      };
      window.fixtureCheck=(label,passed)=>{if(!passed)throw new Error(label);fixtureChecks.push(label);};
      window.settleFixture=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
      function area(name){return {async get(defaults){return structuredClone({...defaults,...fixtureData[name]});},async set(patch){Object.assign(fixtureData[name],structuredClone(patch));}};}
      const eat={lemma:'食べる',baseReading:'たべる',pos:'動詞',isWordLike:true};
      window.fixtureJapaneseTokens=(text)=>{
        if(text==='食べた猫と食べませんでした')return [
          {...eat,surface:'食べた',reading:'たべた',conjugation:{type:'一段',form:'連用形',labels:['过去 / 完了']}},
          {surface:'猫',lemma:'猫',reading:'ねこ',baseReading:'ねこ',pos:'名詞',isWordLike:true},
          {surface:'と',lemma:'と',reading:'と',baseReading:'と',pos:'助詞',grammar:true,isWordLike:true},
          {...eat,surface:'食べませんでした',reading:'たべませんでした',conjugation:{type:'一段',form:'連用形',labels:['礼貌体','否定','过去 / 完了']}}
        ];
        if(text==='食べた')return [{...eat,surface:text,reading:'たべた'}];
        return [{surface:text,lemma:text,reading:'',baseReading:'',pos:'名詞',isWordLike:true}];
      };
      window.chrome={runtime:{id:'ja-browser-fixture',onInstalled:{addListener(){}},onMessage:{addListener(){}},sendMessage(message,callback){
        fixtureMessages.push(structuredClone(message));
        if(message.type==='LM_JA_ANALYZE')return callback({ok:true,tokens:fixtureJapaneseTokens(message.text)});
        if(message.type==='LM_TRANSLATE'){
          if(window.fixtureHoldTranslation){(window.fixtureTranslationCallbacks||=[]).push(()=>callback({ok:true,result:{text:'整句译文：'+message.text}}));return;}
          return callback(window.fixtureTranslationFailure?{ok:false,error:'fixture offline'}:{ok:true,result:{text:'整句译文：'+message.text}});
        }
        if(message.type==='LM_LOOKUP'){
          const japanese=message.from==='ja'?(message.isPhrase?{surface:message.word,lemma:message.word,pos:'短语 / 选区',isPhrase:true}:({...message.japanese,entryId:'10001'})):undefined;
          const reply={ok:true,result:{word:message.word,translation:'测试释义',japanese,entries:[],dictionarySource:'JMdict / EDRDG',dictionaryDate:'2026-10-19',translationSource:'在线翻译',lookupNotice:'可能义项请结合语境判断'}};
          if(window.fixturePauseLookup){window.fixtureResumeLookup=()=>callback(reply);return;}
          return callback(reply);
        }
        if(message.type==='LM_PRONOUNCE')return callback({ok:true,audio:''});
        handleMessage(message).then(callback,error=>callback({ok:false,error:String(error.message)}));
      }},storage:{sync:area('sync'),local:area('local'),onChanged:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}}};
    `;
    const expose = "window.fixture={state,ui,ensureUi,renderWords,renderTranscript,renderCurrent,showDict,saveWord,uniqueWords,renderLearnTab,syncWordMarkers,hideDict,updatePhraseQuery,applyStoredState,queueTranslation,editCaption,alignCues,parseEvents,syncToolbar,onTick,loadCaptions};";
    const content = source("src/content/youtube.js").replace('  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);\n  else boot();', expose);
    const checks = `
      const y=fixture,v=document.querySelector('video');
      Object.defineProperty(v,'currentTime',{value:0.5,writable:true});
      y.state.settings=lmMergeSettings({learningLang:'ja',nativeLang:'zh-CN',japaneseFurigana:'all'});
      y.state.status='ready';y.state.videoId='fixture';y.state.title='Japanese fixture';
      y.state.cues=[{start:0,end:9000,text:'食べた猫と食べませんでした'}];
      y.ensureUi();document.querySelector('.html5-video-player').append(y.ui.root);document.body.append(y.ui.panel);
      y.renderTranscript();y.renderCurrent();await settleFixture();
      let words=[...y.ui.learningLine.querySelectorAll('.lm-word')];
      fixtureCheck('Japanese renders complete inflected learning units',words.length===4&&words[0].dataset.word==='食べた'&&words[3].dataset.word==='食べませんでした');
      fixtureCheck('Japanese ruby uses dictionary reading',words[0].querySelector('rt').textContent==='たべた');
      fixtureCheck('Short Japanese words are never marked rare by length',words.every(word=>!word.classList.contains('lm-rare')));
      await y.showDict(words[0]);await y.ui.vocabButton.ready;
      fixtureCheck('Card shows lemma and inflection labels',y.ui.dict.textContent.includes('食べる')&&y.ui.dict.textContent.includes('过去 / 完了'));
      fixtureCheck('Card labels dictionary attribution and machine translation separately',y.ui.dict.textContent.includes('JMdict / EDRDG')&&y.ui.dict.textContent.includes('译文来源：在线翻译'));
      y.ui.dict.querySelector('.lm-dict-save').click();await y.ui.vocabButton.pending;
      fixtureCheck('Saving persists lemma, reading, surface and video context',fixtureData.local.vocab.length===1&&fixtureData.local.vocab[0].word==='食べる'&&fixtureData.local.vocab[0].japanese.surface==='食べた'&&fixtureData.local.vocab[0].japanese.baseReading==='たべる'&&fixtureData.local.vocab[0].context==='食べた猫と食べませんでした');
      fixtureCheck('All encountered forms show the saved marker even when lookup adds an entry id',words[0].classList.contains('lm-saved')&&words[3].classList.contains('lm-saved'));
      fixtureCheck('Saving never marks the word as mastered',!words[0].classList.contains('lm-known')&&Object.keys(y.state.known).length===0);
      y.ui.dict.querySelector('[data-accent="read"]').click();await settleFixture();
      const pronunciation=fixtureMessages.filter(message=>message.type==='LM_PRONOUNCE').at(-1);
      fixtureCheck('Japanese speech uses kana and Japanese voice',pronunciation.text==='たべる'&&pronunciation.tl==='ja');
      y.ui.dict.querySelector('[data-known]').click();await settleFixture();
      fixtureCheck('Knowing a dictionary entry marks other forms too',words[0].classList.contains('lm-known')&&words[3].classList.contains('lm-known'));
      y.ui.dict.querySelector('[data-known]').click();await settleFixture();
      fixtureCheck('Knowing can be reversed without rebuilding word anchors',!words[0].classList.contains('lm-known')&&y.ui.learningLine.querySelector('.lm-word')===words[0]);
      await y.showDict(words[3]);await y.ui.vocabButton.ready;
      fixtureCheck('Another inflection opens the same saved record',y.ui.dict.querySelector('.lm-dict-save').getAttribute('aria-pressed')==='true');
      y.ui.dict.querySelector('.lm-dict-save').click();await y.ui.vocabButton.pending;
      fixtureCheck('Clicking the saved inflection removes the original entry',fixtureData.local.vocab.length===0&&!words[0].classList.contains('lm-saved'));
      y.hideDict();
      y.state.settings.japaneseFurigana='off';y.renderCurrent();await settleFixture();
      fixtureCheck('Furigana setting applies to current subtitle immediately',!y.ui.learningLine.querySelector('rt'));
      y.state.settings.japaneseFurigana='all';y.renderCurrent();await settleFixture();
      words=[...y.ui.learningLine.querySelectorAll('.lm-word')];
      const selection=document.getSelection(),range=document.createRange();
      range.setStart(words[0].querySelector('ruby').firstChild,0);range.setEnd(words[1].querySelector('ruby').firstChild,1);
      selection.removeAllRanges();selection.addRange(range);y.updatePhraseQuery();
      fixtureCheck('Dragging adjacent ruby words creates an explicit phrase query',!y.ui.phraseQuery.hidden&&y.ui.phraseSelection.surface==='食べた猫'&&y.ui.phraseSelection.isPhrase);
      y.ui.phraseQuery.click();await settleFixture();
      const phrase=fixtureMessages.filter(message=>message.type==='LM_LOOKUP').at(-1);
      fixtureCheck('Phrase lookup excludes ruby and keeps the whole selection',phrase.word==='食べた猫'&&phrase.isPhrase===true&&phrase.context==='食べた猫と食べませんでした');
      selection.removeAllRanges();y.hideDict();
      const changingLine=document.createElement('div');document.body.append(changingLine);
      y.renderWords(changingLine,'食べた','ja');y.renderWords(changingLine,'hello','en');await settleFixture();
      fixtureCheck('A late Japanese analysis cannot overwrite a line switched to English',changingLine.textContent==='hello'&&!changingLine.querySelector('.lm-ja-word'));
      window.fixturePauseLookup=true;const lateCard=y.showDict(words[0]);
      y.state.cues=[{start:0,end:9000,text:'猫'}];y.renderCurrent();
      window.fixtureResumeLookup();window.fixturePauseLookup=false;await lateCard;await settleFixture();
      fixtureCheck('A late word lookup cannot reopen a card after its subtitle anchor disappears',y.ui.dict.classList.contains('lm-hidden'));
      y.state.cues=[{start:0,end:9000,text:'食べた猫と食べませんでした'}];
      y.state.cues.push({start:12000,end:15000,text:'未表示の字幕'});y.renderTranscript();
      const deferredLine=y.ui.panelBody.querySelectorAll('.lm-cue-learning')[1];
      fixtureCheck('An unviewed transcript row defers analysis with an observer',fixtureObserved.has(deferredLine));
      y.state.status='loading';y.renderTranscript();
      fixtureCheck('Replacing the transcript releases observers from removed rows',!fixtureObserved.has(deferredLine)&&!deferredLine.isConnected);
      y.state.status='ready';y.state.cues=y.state.cues.slice(0,1);
      y.state.tab='learn';const vocabulary=await y.uniqueWords();
      fixtureCheck('Japanese learning statistics unify inflections and retain single-character nouns',vocabulary.length===3&&vocabulary.find(item=>item.word==='食べる').count===2&&vocabulary.some(item=>item.word==='猫'));
      y.state.vocab=[{id:'saved-only',word:'猫',lang:'ja',japanese:{lemma:'猫',baseReading:'ねこ',surface:'猫'}}];y.state.known={};
      await y.renderLearnTab();
      fixtureCheck('Coverage requires a known mark, including for short or saved Japanese words',y.ui.panelBody.querySelector('b').textContent==='0%');
      y.state.tab='subs';y.state.learningTrack={kind:'asr',languageCode:'ja'};
      y.state.cues=[{start:0,end:9000,text:'現在の台風の様子を気少衛生ひりから見ていきます。'}];
      y.state.nativeCues=[];y.renderTranscript();y.renderCurrent();
      fixtureCheck('Automatic source is identified without inventing a corrected transcript',y.ui.panelBody.querySelector('.lm-caption-notice').textContent.includes('日语自动字幕')&&y.state.cues[0].text.includes('気少衛生'));
      const timeBefore=v.currentTime;
      y.ui.panelBody.querySelector('[data-caption-action="edit"]').click();
      const editor=y.ui.panelBody.querySelector('.lm-caption-editor'),input=editor.querySelector('textarea');
      fixtureCheck('Correction opens an accessible editor without seeking the video',input.value===y.state.cues[0].text&&v.currentTime===timeBefore&&input.getAttribute('aria-label')==='校正日语原文');
      input.value='現在の台風の様子を気象衛星ひまわりから見ていきます。';
      editor.requestSubmit();await settleFixture();
      fixtureCheck('Correction reanalyses and translates the complete corrected source',y.state.cues[0].text===input.value&&fixtureMessages.filter(m=>m.type==='LM_JA_ANALYZE').some(m=>m.text===input.value)&&fixtureMessages.filter(m=>m.type==='LM_TRANSLATE').at(-1).text===input.value);
      fixtureCheck('New sentence translation reaches both subtitle and transcript',y.ui.nativeLine.textContent==='整句译文：'+input.value&&y.ui.panelBody.querySelector('.lm-cue-native').textContent===y.ui.nativeLine.textContent);
      fixtureCheck('Original source is retained visibly for comparison',y.ui.panelBody.querySelector('.lm-caption-original p').textContent.includes('気少衛生ひり'));
      y.ui.panelBody.querySelector('.lm-caption-original button').click();await settleFixture();
      fixtureCheck('Undo restores and retranslates the original subtitle',y.state.cues[0].text.includes('気少衛生ひり')&&!y.state.cues[0].originalText&&y.ui.nativeLine.textContent.includes('気少衛生ひり'));
      window.fixtureTranslationFailure=true;y.state.nativeCues=[];
      y.ui.panelBody.querySelector('[data-caption-action="translate"]').click();await settleFixture();
      fixtureCheck('Translation failure is visible and can be retried',y.ui.panelBody.querySelector('.lm-cue-native').textContent.includes('翻译失败'));
      window.fixtureTranslationFailure=false;y.ui.panelBody.querySelector('[data-caption-action="translate"]').click();await settleFixture();
      fixtureCheck('Retry clears the failure and shows the full translation',y.ui.panelBody.querySelector('.lm-cue-native').textContent==='整句译文：'+y.state.cues[0].text);
      window.fixtureHoldTranslation=true;
      y.queueTranslation(0,true);await settleFixture();
      const oldCue=y.state.cues[0];y.editCaption(0);
      const nextInput=y.ui.panelBody.querySelector('textarea');nextInput.value='校正した新しい原文。';nextInput.form.requestSubmit();await settleFixture();
      fixtureTranslationCallbacks[0]();await settleFixture();
      fixtureCheck('A late response cannot overwrite a corrected subtitle',!y.state.nativeCues[0]?.text?.includes('気少衛生ひり'));
      fixtureTranslationCallbacks[1]();window.fixtureHoldTranslation=false;await settleFixture();
      fixtureCheck('Latest correction wins even when translations finish out of order',y.state.nativeCues[0].text==='整句译文：校正した新しい原文。');
      window.fixtureHoldTranslation=true;y.queueTranslation(0,true);await settleFixture();
      y.state.loadGen++;y.state.cues=[{start:0,end:1000,text:'別の動画。'}];y.state.nativeCues=[];
      fixtureTranslationCallbacks[2]();window.fixtureHoldTranslation=false;await settleFixture();
      fixtureCheck('Old translations cannot leak into a different video',y.state.nativeCues.length===0);
      y.state.settings.showNative=false;y.state.directTranslation=false;
      y.state.cues=[{start:0,end:4000,text:'最初の字幕です。'},{start:4000,end:7000,text:'次の字幕です。'}];y.state.nativeCues=[];
      v.currentTime=0.5;y.renderTranscript();y.renderCurrent();y.syncToolbar();
      fixtureCheck('Translation toggle explicitly identifies its off state',y.ui.toolbar.querySelector('[data-act="native"]').textContent==='译文：关'&&y.ui.panelBody.querySelector('[data-caption-action="show-native"]').textContent==='显示全部译文');
      window.fixtureHoldTranslation=true;fixtureTranslationCallbacks.length=0;
      y.ui.panelBody.querySelector('.lm-cue[data-index="0"] [data-caption-action="translate"]').click();await settleFixture();
      let manualLine=y.ui.panelBody.querySelector('.lm-cue[data-index="0"] .lm-cue-native');
      fixtureCheck('Manual retranslation visibly shows progress even when global translations are hidden',!manualLine.hidden&&getComputedStyle(manualLine).display!=='none'&&manualLine.textContent.includes('翻译中')&&!y.ui.nativeLine.classList.contains('lm-hidden'));
      fixtureTranslationCallbacks[0]();window.fixtureHoldTranslation=false;await settleFixture();
      fixtureCheck('Manual result is visibly rendered in overlay and sidebar despite the off preference',!manualLine.hidden&&manualLine.getBoundingClientRect().height>0&&y.ui.nativeLine.getBoundingClientRect().height>0&&manualLine.textContent==='整句译文：最初の字幕です。');
      fixtureCheck('Manual request leaves unrelated hidden rows and stored preference alone',y.ui.panelBody.querySelector('.lm-cue[data-index="1"] .lm-cue-native').hidden&&y.state.settings.showNative===false);
      y.renderTranscript();y.renderCurrent();await settleFixture();
      fixtureCheck('Manual result stays visible through subtitle and sidebar rerenders',!y.ui.panelBody.querySelector('.lm-cue[data-index="0"] .lm-cue-native').hidden&&!y.ui.nativeLine.classList.contains('lm-hidden'));
      y.state.nativeCues=[];window.fixtureTranslationFailure=true;
      y.ui.panelBody.querySelector('.lm-cue[data-index="0"] [data-caption-action="translate"]').click();await settleFixture();
      fixtureCheck('Manual translation failure is visible while translations are switched off',!y.ui.panelBody.querySelector('.lm-cue-native').hidden&&y.ui.panelBody.querySelector('.lm-cue-native').textContent.includes('翻译失败'));
      window.fixtureTranslationFailure=false;
      y.ui.panelBody.querySelector('[data-caption-action="show-native"]').click();await settleFixture();
      fixtureCheck('Sidebar control enables and persists all translations',y.state.settings.showNative===true&&fixtureData.sync.showNative===true&&y.ui.toolbar.querySelector('[data-act="native"]').textContent==='译文：开');
      y.ui.toolbar.querySelector('[data-act="native"]').click();await settleFixture();
      fixtureCheck('Turning translations off hides manually revealed results too',y.state.settings.showNative===false&&y.ui.panelBody.querySelector('.lm-cue-native').hidden&&y.ui.nativeLine.classList.contains('lm-hidden'));
      y.state.cues=y.parseEvents({events:[{tStartMs:0,dDurationMs:10000,segs:[{utf8:'最初の字幕です。'}]},{tStartMs:4000,dDurationMs:6000,segs:[{utf8:'次の字幕です。'}]}]},{japanese:true,asr:true});
      y.renderTranscript();v.currentTime=3.999;y.onTick();await settleFixture();
      fixtureCheck('Original caption remains until the next source timestamp',lmJapaneseUi.textWithoutReading(y.ui.learningLine)==='最初の字幕です。');
      v.currentTime=4;v.dispatchEvent(new Event('timeupdate'));await settleFixture();
      fixtureCheck('Caption switches on video timeupdate without waiting for translation or merged paragraphs',lmJapaneseUi.textWithoutReading(y.ui.learningLine)==='次の字幕です。'&&y.ui.panelBody.querySelector('.lm-cue.active').dataset.index==='1');
      const trackRequests=[];let missingTranslationTrack=false;
      window.addEventListener('message',event=>{
        const message=event.data;if(message?.source!=='linguamate-content')return;
        let data;
        if(message.type==='LM_PING')data={ok:true};
        if(message.type==='LM_GET_TRACKS')data={videoId:'fixture',tracks:[{languageCode:'ja',kind:'asr',baseUrl:'https://example.test/ja'}]};
        if(message.type==='LM_FETCH_TRACK'){
          trackRequests.push(message.data);
          data={text:message.data.tlang&&missingTranslationTrack?'':JSON.stringify({events:[
            {tStartMs:0,dDurationMs:7000,segs:[{utf8:message.data.tlang?'第一条完整译文。':'最初の字幕です。'}]},
            {tStartMs:4000,dDurationMs:3000,segs:[{utf8:message.data.tlang?'第二条完整译文。':'次の字幕です。'}]}
          ]})};
        }
        if(data)window.postMessage({source:'linguamate-page',requestId:message.requestId,data},'*');
      });
      y.state.settings.showNative=true;v.currentTime=.5;
      let translationCount=fixtureMessages.filter(m=>m.type==='LM_TRANSLATE').length;
      await y.loadCaptions(true);await settleFixture();
      fixtureCheck('Loading Japanese captions retrieves the entire timed translation track',trackRequests.length===2&&trackRequests[1].tlang==='zh-Hans'&&y.state.nativeCues[1].text==='第二条完整译文。');
      fixtureCheck('A successful timed track requires no separate network translation for every caption',fixtureMessages.filter(m=>m.type==='LM_TRANSLATE').length===translationCount&&y.ui.nativeLine.textContent==='第一条完整译文。');
      missingTranslationTrack=true;
      await y.loadCaptions(true);await settleFixture();
      fixtureCheck('A missing timed track falls back to translating displayed source cues',y.state.nativeTrackLoading===false&&y.state.nativeCues[0].text==='整句译文：最初の字幕です。'&&fixtureMessages.filter(m=>m.type==='LM_TRANSLATE').length>translationCount);
    `;
    const finish = `(async()=>{try{${checks}\n document.title='LM_JA_YT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:true,checks:fixtureChecks}))));}catch(error){document.title='LM_JA_YT:'+btoa(unescape(encodeURIComponent(JSON.stringify({passed:false,error:error.stack,checks:fixtureChecks}))));}})();`;
    const scripts = [bridge, source("src/background/service-worker.js"), ...["languages", "defaults", "frequency", "captions", "feedback", "japanese", "japanese-ui", "japanese-client", "vocab-button", "word-card"].map((name) => source(`src/shared/${name}.js`)), content, finish];
    const html = `<!doctype html><meta charset="utf-8"><title>pending</title><style>body{margin:0;background:#111}video{display:block;width:800px;height:450px}${source("src/content/youtube.css")}</style><div class="html5-video-player"><video></video></div>${scripts.map((script) => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`;
    const file = path.join(directory, "japanese.html");
    fs.writeFileSync(file, html, "utf8");
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--window-size=1280,900", "--virtual-time-budget=7000", "--dump-dom", pathToFileURL(file).href + "?v=fixture"], { encoding: "utf8", timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const encoded = output.match(/<title>LM_JA_YT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Browser did not complete: ${output.slice(0, 300)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.passed, true, JSON.stringify(result, null, 2));
    assert.ok(result.checks.length >= 18);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
