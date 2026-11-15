const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const response = value => ({ok:true,status:200,json:async()=>value});
const google = text => response([[[text]]]);
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done;}); return {promise,resolve}; };
const settle = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
function harness(fetch) {
  const scope=vm.createContext({fetch,URLSearchParams,AbortSignal,console:{warn(){}},
    chrome:{runtime:{onInstalled:{addListener(){}},onMessage:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}}}});
  vm.runInContext(fs.readFileSync(path.join(root,'src/background/service-worker.js'),'utf8'),scope);
  return scope;
}

test('switching words in one sentence reuses the same pending context translation', async()=>{
  const held=deferred();let calls=0;
  const scope=harness(async()=>{calls++;return held.promise;});
  const first=scope.translateText('We sat on the river bank.','en','zh-CN');
  const second=scope.translateText('We sat on the river bank.','en','zh-CN');
  assert.equal(calls,1);
  held.resolve(google('我们坐在河岸上。'));
  assert.equal((await first).text,'我们坐在河岸上。');
  assert.equal((await second).text,'我们坐在河岸上。');
  await scope.translateText('We sat on the river bank.','en','zh-CN');
  assert.equal(calls,1);
});

test('overlapping gloss batches and single translations share definitions in flight', async()=>{
  const held=[];
  const scope=harness(async url=>{const item={query:new URL(url).searchParams.get('q'),...deferred()};held.push(item);return item.promise;});
  const first=scope.translateLines(['alpha','beta','alpha'],'en','zh-CN');
  const second=scope.translateLines(['beta','gamma'],'en','zh-CN');
  const individual=scope.translateText('beta','en','zh-CN');
  assert.equal(held.length,2);
  assert.equal(held[0].query,'[0] alpha\n[1] beta');
  assert.equal(held[1].query,'[1] gamma');
  held[0].resolve(google('[0] 甲\n[1] 乙'));held[1].resolve(google('[1] 丙'));
  assert.deepEqual(Array.from(await first),['甲','乙','甲']);
  assert.deepEqual(Array.from(await second),['乙','丙']);
  assert.equal((await individual).text,'乙');
});

test('explicit retranslation supersedes a slower automatic request in the cache', async()=>{
  const held=[];
  const scope=harness(async()=>{const item=deferred();held.push(item);return item.promise;});
  const old=scope.translateText('雨です。','ja','zh-CN');
  const fresh=scope.translateText('雨です。','ja','zh-CN',true);
  held[1].resolve(google('新译文'));await fresh;
  held[0].resolve(google('旧译文'));await old;
  assert.equal((await scope.translateText('雨です。','ja','zh-CN')).text,'新译文');
  assert.equal(held.length,2);
});

test('a refresh also supersedes an older batched gloss without deadlocking its followers', async()=>{
  const held=[];
  const scope=harness(async()=>{const item=deferred();held.push(item);return item.promise;});
  const batch=scope.translateLines(['weather satellite'],'en','zh-CN');
  const fresh=scope.translateText('weather satellite','en','zh-CN',true);
  held[1].resolve(google('气象卫星'));await fresh;
  held[0].resolve(google('[0] 旧的卫星译文'));await batch;
  assert.equal((await scope.translateText('weather satellite','en','zh-CN')).text,'气象卫星');
});

test('failed shared translations are removed and retryable', async()=>{
  let calls=0,fail=true;
  const scope=harness(async()=>{calls++;if(fail)throw new Error('offline');return google('成功');});
  const results=await Promise.allSettled([scope.translateText('hello','en','zh-CN'),scope.translateText('hello','en','zh-CN')]);
  assert.ok(results.every(result=>result.status==='rejected'));assert.equal(calls,2);
  fail=false;assert.equal((await scope.translateText('hello','en','zh-CN')).text,'成功');assert.equal(calls,3);
});

test('returning to a staged English lookup includes translated glosses immediately', async()=>{
  let calls=0;
  const scope=harness(async url=>{
    calls++;
    return String(url).includes('dictionaryapi')?response([{word:'bank',phonetics:[],meanings:[{partOfSpeech:'noun',definitions:[{definition:'An edge of a river.'}]}]}]):google('[0] 河岸');
  });
  const first=await scope.lookupWord('bank','en','zh-CN','First sentence.',null,true);
  assert.equal(first.entries[0].items[0].gloss,'');
  await scope.translateLines(['An edge of a river.'],'en','zh-CN');
  const next=await scope.lookupWord('bank','en','zh-CN','Another sentence.',null,true);
  assert.equal(next.entries[0].items[0].gloss,'河岸');assert.equal(next.translation,'河岸');
  assert.equal(next.context,'Another sentence.');assert.equal(first.entries[0].items[0].gloss,'');assert.equal(calls,2);
});

test('Japanese matched entries survive shard eviction and restore cached glosses', async()=>{
  const reads=[],scope=vm.createContext({setTimeout,clearTimeout,Response,DecompressionStream,
    chrome:{runtime:{getURL:file=>'chrome-extension://fixture/'+file}},
    fetch:async url=>{const file=url.replace('chrome-extension://fixture/','').replace(/^\//,'');reads.push(file);return new Response(fs.readFileSync(path.join(root,file)));},
    translateText:async()=>({text:''}),translateLines:async()=>[]});
  for(const file of ['vendor/kuromoji/kuromoji','shared/japanese','background/japanese-service'])vm.runInContext(fs.readFileSync(path.join(root,`src/${file}.js`),'utf8'),scope);
  const service=scope.lmJapaneseService;
  const first=await service.lookup('食べた','zh-CN','猫が食べた。',{},true);
  for(const word of ['銀行','天気','飲む','日本','見る','取る','学校','駅','犬','歩く','仕事','音楽'])await service.lookup(word,'en','',{},true);
  assert.ok(new Set(reads.filter(file=>/extended\/\d+/.test(file))).size>4);
  const before=reads.length;
  scope.cacheGet=key=>key===`t:en:zh-CN:${first.entries[0].items[0].definition}`?{text:'吃'}:null;
  const again=await service.lookup('食べた','zh-CN','猫が食べた。',{},true);
  assert.equal(reads.length,before,'returning to a known word does not read/decompress an evicted shard');
  assert.equal(again.entries[0].items[0].gloss,'吃');assert.equal(again.translation,'吃');
});
