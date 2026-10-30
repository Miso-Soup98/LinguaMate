const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../src/background/service-worker.js'), 'utf8');
const ok = value => ({ok:true,status:200,json:async()=>value});
const record = (word, definitions, pos='verb') => ({word, phonetics:[], meanings:[{partOfSpeech:pos, definitions:definitions.map(definition=>typeof definition==='string'?{definition}:definition)}]});
function harness(dictionary) {
  const requests=[];
  const context=vm.createContext({URLSearchParams,AbortSignal,console:{warn(){}},
    fetch:async url=>{
      requests.push(String(url));
      if(String(url).includes('dictionaryapi')) {
        const word=decodeURIComponent(new URL(url).pathname.split('/').at(-1));
        const entries=await dictionary(word);
        return entries ? ok(entries) : {ok:false,status:404};
      }
      return String(url).includes('googleapis') ? ok([[['单词译文']]]) : ok({responseStatus:200,responseData:{translatedText:'在线译文'}});
    }, chrome:{runtime:{onInstalled:{addListener(){}},onMessage:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}}}});
  vm.runInContext(source,context);
  return {context,requests};
}

test('English keeps all dictionary records, parts of speech, senses and examples', async()=>{
  const {context}=harness(()=>[
    record('set', Array.from({length:14},(_,i)=>({definition:`Meaning ${i}`,example:`Example ${i}`}))),
    record('set',['A collection.'],'noun'), record('set',['Fixed.'],'adjective')
  ]);
  const result=await context.lookupWord('set','en','zh-CN','Set the alarm.',null,true);
  assert.equal(result.entries.reduce((n,e)=>n+e.items.length,0),16);
  assert.equal(result.entries[0].items[13].example,'Example 13');
  assert.equal(result.entries.at(-1).pos,'adjective');
  assert.match(result.dictionarySource,/Dictionary API/);
});

test('dictionary-attested English inflections expose actual base meanings without overwriting surface', async()=>{
  const {context}=harness(word=>word==='took'?[record(word,['simple past tense of take.'])]:word==='take'?[record(word,['To require time.','To carry something.'])]:null);
  const result=await context.lookupWord('took','en','zh-CN','It took two hours.',null,true);
  assert.equal(result.word,'took');assert.equal(result.dictionaryHeadword,'take');
  assert.equal(result.entries[0].items[0].definition,'To require time.');
  assert.equal(result.englishForms[0].lemma,'take');
  assert.ok(result.entries.some(entry=>entry.headword==='took'));
});

test('homographs preserve their direct definitions alongside explicit form relations', async()=>{
  const {context}=harness(word=>word==='saw'?[record(word,['A tool for cutting.'],'noun'),record(word,['simple past tense of see.'])]:[record('see',['To perceive visually.'])]);
  const result=await context.fetchEnglishEntry('saw');
  assert.equal(result.headword,'saw');
  assert.equal(result.entries[0].items[0].definition,'A tool for cutting.');
  assert.ok(result.entries.some(entry=>entry.headword==='see'));
});

test('an inflected verb may expose base noun senses but never promotes them as its contextual meaning', async()=>{
  const {context}=harness(word=>word==='took'?[record(word,['To use up time.'])]:[record('take',['To use up time.']),record('take',[{definition:'A film scene recorded at one time.',example:'We recorded two takes.'}],'noun')]);
  const result=await context.fetchEnglishEntry('took');
  assert.equal(result.headword,'take');
  assert.equal(result.forms[0].lemma,'take');
  assert.equal(result.entries.find(entry=>entry.pos==='noun').contextEligible,false);
});

test('missing regular inflections try only dictionary-verified candidates and keep complete phrases intact', async()=>{
  const {context,requests}=harness(word=>word==='study'?[record(word,['To learn.'])]:null);
  const result=await context.fetchEnglishEntry('studied');
  assert.equal(result.forms[0].lemma,'study');
  assert.equal(await context.fetchEnglishEntry('made up'),null);
  assert.ok(requests.some(url=>url.endsWith('made%20up')));
  assert.ok(!requests.some(url=>url.endsWith('/made')));
});

test('staged lookup returns dictionary data without waiting for machine translation and refreshes context on cache hits', async()=>{
  const {context,requests}=harness(word=>[record(word,['A financial institution.','The edge of a river.'],'noun')]);
  const a=await context.lookupWord('bank','en','zh-CN','I went to the bank.',null,true);
  const b=await context.lookupWord('Bank','en','zh-CN','We sat on the river bank.',null,true);
  assert.equal(a.context,'I went to the bank.');assert.equal(b.context,'We sat on the river bank.');assert.equal(b.word,'Bank');
  assert.equal(requests.length,1);assert.match(requests[0],/dictionaryapi/);
});

test('dictionary network failures keep a labelled translation fallback and are retryable', async()=>{
  let count=0;
  const {context}=harness(()=>{count++;throw new Error('offline');});
  const first=await context.lookupWord('word','en','zh-CN','',null,true);
  assert.equal(first.translation,'在线译文');assert.match(first.lookupNotice,/未找到词典/);
  await context.lookupWord('word','en','zh-CN','',null,true);
  assert.equal(count,2);
});

test('definition batches reject oversized or malformed requests before network access', async()=>{
  const {context,requests}=harness(()=>null);
  for(const lines of [Array(9).fill('word'),[{}],['x'.repeat(3001)]]) await assert.rejects(context.handleMessage({type:'LM_GLOSS_TRANSLATE',lines,to:'zh-CN'}),/invalid_/);
  assert.equal(requests.length,0);
});

test('context candidates use dictionary evidence, preserve distinct senses, and do not claim certain disambiguation',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/shared/word-card.js'),'utf8'),context);
  const card=context.lmWordCard;
  const senses=[{definition:'A financial institution.'},{definition:'The land at the side of a river.'}];
  assert.equal(card.contextMatches(senses,'We sat by the river bank.','bank')[0].index,1);
  assert.equal(card.contextMatches(senses,'This is a bank.','bank').length,0);
  const time=card.contextMatches([{definition:'To carry something.'},{definition:'To require time.'}],'It took two hours to finish.','took take');
  assert.equal(time[0].index,1);
  assert.match(card.html({word:'<img onerror=x>',entries:[]},'<script>x</script>','en'),/&lt;script&gt;/);
  assert.doesNotMatch(card.html({word:'<img onerror=x>',entries:[]},'','en'),/<img/);
});
