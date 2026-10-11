import { hasPrivatePermissions } from '../../server/private-permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderSettings, normalizeSettings, validateProviderEndpoint } from '../../server/provider-settings.mjs';
import { catalogModel, createOpenRouterCatalog } from '../../server/openrouter-models.mjs';

test('fresh settings default to Agnes and explicit environment configuration remains provider-scoped',()=>{
  assert.equal(normalizeSettings().providerId,'agnes-ai');
  const env=normalizeSettings({}, {MODEL_PROVIDER:'openrouter',OPENROUTER_API_KEY:'router-key',AGNES_API_KEY:'agnes-key',AGNES_BASE_URL:'https://agnes.example/v1',AGNES_MODEL:'agnes-test'});
  assert.equal(env.providerId,'openrouter');assert.equal(env.providers.openrouter.apiKey,'router-key');assert.equal(env.providers['agnes-ai'].apiKey,'agnes-key');assert.equal(env.providers['agnes-ai'].baseUrl,'https://agnes.example/v1');assert.equal(env.providers['agnes-ai'].model,'agnes-test');assert.equal(env.providers['openai-compatible'].apiKey,'');
});
test('migration, provider switching, clearing and endpoint changes never forward another stored key',async()=>{
  const root=await mkdtemp(join(tmpdir(),'provider-settings-'));const path=join(root,'settings.json');
  const store=createProviderSettings({path,env:{},resolveOpenRouterModel:async id=>({id,input:['text','image']})});
  try{
    await writeFile(path,JSON.stringify({providerId:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'minimax/minimax-m3',apiKey:'preserved-router-key',usageEnabled:true}),{mode:0o600});
    assert.equal((await store.current()).apiKey,'preserved-router-key');
    await store.save({providerId:'openai-compatible',baseUrl:'https://one.example/v1',model:'model-a',apiKey:'own-openai-key',usageEnabled:true});
    assert.equal((await store.current()).apiKey,'own-openai-key');
    const publicValue=await store.publicSettings();assert.ok(!JSON.stringify(publicValue).includes('own-openai-key'));assert.ok(!JSON.stringify(publicValue).includes('preserved-router-key'));assert.equal(publicValue.providers.openrouter.hasKey,true);
    await store.save({providerId:'openrouter',usageEnabled:true});assert.equal((await store.current()).apiKey,'preserved-router-key');
    await store.save({providerId:'openai-compatible',baseUrl:'https://two.example/v1',model:'model-b',usageEnabled:true});assert.equal((await store.current()).apiKey,'');assert.equal((await store.current()).usageEnabled,false);
    await store.save({providerId:'openrouter',clearKey:true,usageEnabled:true});assert.equal((await store.current()).apiKey,'');assert.equal(await hasPrivatePermissions(path),true);
    assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('OpenRouter cannot use an unmanaged compatible route and endpoint credentials are rejected',()=>{
  assert.throws(()=>validateProviderEndpoint('openai-compatible','https://openrouter.ai/api/v1'));
  assert.throws(()=>validateProviderEndpoint('agnes-ai','https://user:key@host.example/v1'));
  assert.equal(validateProviderEndpoint('anthropic-compatible','https://service.example/v1'),'https://service.example');
});
const rawModel=()=>({id:'fixture/model',name:'Fixture',architecture:{input_modalities:['text','image'],output_modalities:['text']},context_length:128000,top_provider:{max_completion_tokens:8192},supported_parameters:['tools','tool_choice','max_tokens'],pricing:{prompt:'0.0000003',completion:'0.0000012',input_cache_read:'0.00000006'}});
test('model catalogue covers cache reads and rejects extra charges, unknown prices and expensive context ceilings',()=>{
  const good=catalogModel(rawModel());assert.equal(good.selectable,true);assert.equal(good.modelInfo.pricing.inputMicrosPerMillion,300000);
  for(const pricing of [{...rawModel().pricing,image:'0.003'},{...rawModel().pricing,request:'0.001'},{...rawModel().pricing,input_cache_write:'0.000001'},{completion:'0.1'},{prompt:'0.00003',completion:'0.00006'}])assert.equal(catalogModel({...rawModel(),pricing}).selectable,false);
  assert.equal(catalogModel({...rawModel(),supported_parameters:['tools']}).selectable,false);
});
test('directory discovery is a keyless read and exposes selectable metadata without private model objects',async()=>{
  let count=0;const catalog=createOpenRouterCatalog({fetchImpl:async(url,options)=>{count++;assert.equal(url,'https://openrouter.ai/api/v1/models');assert.equal(options.headers,undefined);return Response.json({data:[rawModel()]});}});
  const list=await catalog.list();assert.equal(list.models[0].selectable,true);assert.equal(list.models[0].modelInfo,undefined);assert.equal((await catalog.resolve('fixture/model')).id,'fixture/model');assert.equal(count,1);
});
test('the thinking switch is stored per compatible connection and never applies to Agnes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'provider-thinking-'));const path=join(root,'settings.json');
  const store=createProviderSettings({path,env:{}});
  try{
    await store.save({providerId:'openai-compatible',baseUrl:'https://api.minimax.example/v1',model:'MiniMax-M3',apiKey:'k',usageEnabled:true,thinkingDisabled:true});
    assert.equal((await store.current()).thinkingDisabled,true);
    assert.equal((await store.publicSettings()).providers['openai-compatible'].thinkingDisabled,true);
    await store.save({providerId:'openai-compatible',usageEnabled:true});assert.equal((await store.current()).thinkingDisabled,true);
    await store.save({providerId:'agnes-ai',thinkingDisabled:true});assert.equal((await store.current()).thinkingDisabled,false);
    await store.save({providerId:'openai-compatible',thinkingDisabled:false});assert.equal((await store.current()).thinkingDisabled,false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('the model dialog sends only endpoint, model and key: calls enable with a key, MiniMax-M3 skips thinking automatically',async()=>{
  const root=await mkdtemp(join(tmpdir(),'provider-defaults-'));const path=join(root,'settings.json');
  const store=createProviderSettings({path,env:{}});
  try{
    await store.save({providerId:'openai-compatible',baseUrl:'https://api.minimax.example/v1',model:'MiniMax-M3',apiKey:'k'});
    let current=await store.current();
    assert.equal(current.usageEnabled,true);assert.equal(current.visionEnabled,true);assert.equal(current.thinkingDisabled,true);
    await store.save({providerId:'openai-compatible',model:'gpt-example'});
    current=await store.current();assert.equal(current.thinkingDisabled,false);assert.equal(current.usageEnabled,true);
    await store.save({providerId:'anthropic-compatible',baseUrl:'https://compatible.example',model:'claude-example'});
    current=await store.current();assert.equal(current.usageEnabled,false);
  }finally{await rm(root,{recursive:true,force:true});}
});
