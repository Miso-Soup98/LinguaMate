const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(fetch) {
  const context = vm.createContext({fetch, URLSearchParams, AbortSignal, console:{warn(){}},
    chrome:{runtime:{onInstalled:{addListener(){}},onMessage:{addListener(){}}},contextMenus:{onClicked:{addListener(){}}}}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../src/background/service-worker.js'),'utf8'),context);
  return context;
}
const response = value => ({ok:true,status:200,json:async()=>value});
test('dictionary glosses recover missing or fullwidth batch markers and cache by definition', async()=>{
  const queries=[];
  const h=harness(async url=>{
    const query=new URL(url).searchParams.get('q');queries.push(query);
    if(query.startsWith('[0]'))return response([[['［0］ 气象卫星',null,null,null]]]);
    return response([[['风速',null,null,null]]]);
  });
  const first=await h.translateLines(['weather satellite','wind speed'],'en','zh-CN');
  assert.deepEqual(Array.from(first),['气象卫星','风速']);
  assert.equal(queries.length,2);
  assert.equal(queries[1],'wind speed');
  assert.deepEqual(Array.from(await h.translateLines(['weather satellite','wind speed'],'en','zh-CN')),['气象卫星','风速']);
  assert.equal(queries.length,2,'hovering a previously looked-up word reuses the translated definition');
});
test('rate limits use fallback without repeatedly hitting the limited provider', async()=>{
  let google=0,fallback=0;
  const h=harness(async url=>{
    if(String(url).includes('googleapis')){google++;return {ok:false,status:429};}
    fallback++;return response({responseStatus:200,responseData:{translatedText:'完整译文'}});
  });
  assert.equal((await h.translateText('気象衛星から見ていきます。','ja','zh-CN')).text,'完整译文');
  await h.translateText('次の字幕。','ja','zh-CN');
  assert.equal(google,1);assert.equal(fallback,2);
});
test('provider quota errors never become subtitle translations or cache entries', async()=>{
  let count=0;
  const h=harness(async url=>{
    if(String(url).includes('googleapis'))return {ok:false,status:429};
    count++;return response({responseStatus:403,responseData:{translatedText:'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS'}});
  });
  await assert.rejects(h.translateText('雨です。','ja','zh-CN'),/translation_unavailable/);
  await assert.rejects(h.translateText('雨です。','ja','zh-CN'),/translation_unavailable/);
  assert.equal(count,2,'failed requests can be retried and are never cached as successful translations');
});

test('explicit retranslation bypasses a cached translation', async()=>{
  let count=0;
  const h=harness(async()=>response([[[`译文${++count}`,null,null,null]]]));
  assert.equal((await h.translateText('雨です。','ja','zh-CN')).text,'译文1');
  assert.equal((await h.translateText('雨です。','ja','zh-CN')).text,'译文1');
  assert.equal((await h.translateText('雨です。','ja','zh-CN',true)).text,'译文2');
});
