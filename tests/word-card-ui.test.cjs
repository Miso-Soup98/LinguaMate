const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>file&&fs.existsSync(file));

test('shared English/Japanese cards expose context, late meanings, retry, selected-meaning storage and stale-response isolation in Chrome', {timeout:45000}, t=>{
  if(!chrome)return t.skip('Set CHROME_PATH for browser checks');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'linguamate-word-card-'));
  try {
    const bridge=`
      const dataStore={sync:{},local:{vocab:[],known:{}}};
      function storage(name){return{async get(defaults){return structuredClone({...defaults,...dataStore[name]});},async set(values){Object.assign(dataStore[name],structuredClone(values));}};}
      window.chrome={runtime:{onInstalled:{addListener(){}},onMessage:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}},storage:{sync:storage('sync'),local:storage('local')}};
      window.fetch=()=>{throw new Error('Unexpected network request in fixture');};
      const requests=[],checks=[];
      let failContext=true,failGloss=true,hold=false,resumeOld;
      const settle=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
      const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
      const send=async(type,message={})=>{
        requests.push({type,...message});
        if(type==='LM_GLOSS_TRANSLATE')return failGloss?{ok:false}:{ok:true,glosses:message.lines.map(line=>'译义：'+line)};
        if(type==='LM_TRANSLATE'){
          if(hold)return new Promise(resolve=>{resumeOld=resolve;});
          if(failContext)return{ok:false};
          return {ok:true,result:{text:message.to==='en'?'take medicine.':message.text==='薬を飲む。'?'吃药。':'他们坐在河岸上。'}};
        }
        return handleMessage({type,...message});
      };
      const container=document.querySelector('#card');
      let generation=0,binding,card;
      function mount(data,context,from='en'){
        const token=++generation;
        container.innerHTML='<div class="lm-dict-word">'+lmWordCard.highlight(data.word,'')+'</div><div class="lm-dict-trans"></div>'+lmWordCard.html(data,context,from)+'<button class="lm-dict-save">加入生词本</button>';
        binding=lmBindVocabButton(container.querySelector('.lm-dict-save'),{word:data.word,lang:from,send,createItem:()=>({translation:data.translation||'',context,nativeLang:'zh-CN'})});
        const captured=binding;
        card=lmWordCard.bind(container,{data,context,from,to:'zh-CN',send,isCurrent:()=>token===generation,onSaveMeaning:meaning=>captured.saveMeaning(meaning),onQuery:query=>{window.lastQuery=query;}});
      }
    `;
    const checks=`
      const meanings=Array.from({length:15},(_,i)=>({definition:'Definition number '+i,example:i===0?'They sat on a bank.':''}));
      meanings[8]={definition:'An edge of a river.',gloss:''};
      mount({word:'bank',entries:[{pos:'noun',items:meanings}],dictionarySource:'Free Dictionary API / Wiktionary'},'They sat on the river bank.');
      await settle();await binding.ready;
      check(container.querySelectorAll('.lm-card-senses .lm-entry').length===6,'initial card limits visible entries without dropping the other meanings');
      check(!container.querySelector('.lm-card-retry').hidden&&container.querySelector('.lm-context-translation').textContent.includes('暂不可用'),'context failure remains visible and can be retried');
      check(!container.querySelector('.lm-card-gloss-retry').hidden,'failed glossary translation retains definitions and exposes retry');
      failContext=false;failGloss=false;
      container.querySelector('.lm-card-retry').click();container.querySelector('.lm-card-gloss-retry').click();await settle();
      check(container.querySelector('.lm-context-translation').textContent==='他们坐在河岸上。','context retry displays the complete translated sentence');
      check(container.querySelector('.lm-card-context-senses').textContent.includes('river'),'a relevant late sense is accessible without opening all preceding senses');
      check(container.querySelector('.lm-card-context-senses').textContent.includes('待确认'),'lexical suggestions are explicitly uncertain');
      container.querySelector('.lm-card-more').click();await settle();
      check(container.querySelectorAll('.lm-card-senses .lm-entry').length===12,'more meanings expands the next page');
      check(container.querySelector('[data-sense="8"] .lm-gloss').textContent.includes('译义：'),'expanded entries are translated');
      container.querySelector('[data-sense="8"] [data-save-sense]').click();await settle();await binding.pending;
      check(dataStore.local.vocab.length===1&&dataStore.local.vocab[0].translation==='译义：An edge of a river.','saving a late sense stores the selected meaning rather than the first meaning');
      dataStore.local.vocab[0].due=12345;dataStore.local.vocab[0].reps=8;
      container.querySelector('[data-sense="1"] [data-save-sense]').click();await settle();await binding.pending;
      check(dataStore.local.vocab.length===1&&dataStore.local.vocab[0].translation==='译义：Definition number 1'&&dataStore.local.vocab[0].due===12345&&dataStore.local.vocab[0].reps===8,'choosing another sense updates the existing record without resetting reviews');
      hold=true;container.querySelector('[data-example]').click();await settle();
      const exampleReply=resumeOld;hold=false;container.querySelector('.lm-card-more').click();await settle();
      exampleReply({ok:true,result:{text:'他们坐在河岸上。'}});await settle();
      check(container.querySelector('.lm-example-translation').textContent==='他们坐在河岸上。','dictionary examples can be translated independently');
      const input=container.querySelector('.lm-card-query input');input.value='take off';container.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      check(lastQuery==='take off','manual query passes the whole phrase');
      hold=true;mount({word:'old',entries:[]},'An old sentence.');await settle();
      const resolve=resumeOld;hold=false;mount({word:'new',entries:[]},'A new sentence.');await settle();
      const before=container.textContent;resolve({ok:true,result:{text:'STALE_TRANSLATION'}});await settle();
      check(container.textContent===before&&!container.textContent.includes('STALE_TRANSLATION'),'late responses cannot rewrite the next word card');
      mount({word:'飲む',entries:[{pos:'verb',reading:'のむ',items:[{definition:'to drink; to swallow; to take (medicine)',gloss:'喝；吞咽；服用（药物）'}]}],dictionaryHeadword:'飲む',dictionarySource:'JMdict / EDRDG'},'薬を飲む。','ja');
      await settle();await binding.ready;
      check(container.querySelector('.lm-context-translation').textContent==='吃药。','Japanese context is translated independently of the isolated word');
      const candidate=container.querySelector('.lm-card-context-senses');
      check(candidate.textContent.includes('to take (medicine)')&&!candidate.textContent.includes('to drink'),'context reference extracts the matching gloss clause while retaining the full original dictionary entry below');
      candidate.querySelector('button').click();await settle();await binding.pending;
      check(dataStore.local.vocab.find(row=>row.word==='飲む').translation==='译义：to take (medicine)','contextual clause can be saved as the learning meaning');
      check(container.scrollWidth<=container.clientWidth,'long definitions and usage labels do not overflow the card horizontally');
      check(requests.filter(r=>r.type==='LM_GLOSS_TRANSLATE').every(r=>r.lines.length<=6),'gloss batches remain bounded');
      window.checks=checks;
    `;
    const finish=`(async()=>{try{${checks}document.title='LM_WORD_CARD:'+btoa(unescape(encodeURIComponent(JSON.stringify({ok:true,checks}))));}catch(error){document.title='LM_WORD_CARD:'+btoa(unescape(encodeURIComponent(JSON.stringify({ok:false,error:error.stack,checks}))));}})();`;
    const scripts=[bridge,source('src/background/service-worker.js'),source('src/shared/vocab-button.js'),source('src/shared/word-card.js'),finish];
    const file=path.join(directory,'card.html');
    fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><title>pending</title><style>body{background:#111827;font-family:Arial}${source('src/content/youtube.css')}</style><div id="card" class="lm-dict" style="top:30px;left:30px"></div>${scripts.map(script=>'<script>'+script.replace(/<\/script/gi,'<\\/script')+'</script>').join('')}`);
    const output=execFileSync(chrome,['--headless','--disable-gpu','--disable-extensions','--no-first-run',`--user-data-dir=${path.join(directory,'profile')}`,'--window-size=900,900','--virtual-time-budget=5000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:35000,maxBuffer:4*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const encoded=output.match(/<title>LM_WORD_CARD:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded,'Browser did not complete checks');
    const result=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
    assert.equal(result.ok,true,JSON.stringify(result,null,2));
    if(process.env.LM_WORD_CARD_SCREENSHOT){
      const snapshot=path.join(directory,'snapshot.html');fs.writeFileSync(snapshot,output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
      execFileSync(chrome,['--headless','--disable-gpu','--disable-extensions','--no-first-run',`--user-data-dir=${path.join(directory,'snapshot-profile')}`,'--window-size=900,900','--virtual-time-budget=1000',`--screenshot=${path.resolve(process.env.LM_WORD_CARD_SCREENSHOT)}`,pathToFileURL(snapshot).href],{timeout:35000,windowsHide:true,stdio:'ignore'});
    }
  } finally {
    if(path.dirname(path.resolve(directory))===path.resolve(os.tmpdir())&&path.basename(directory).startsWith('linguamate-word-card-'))fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
