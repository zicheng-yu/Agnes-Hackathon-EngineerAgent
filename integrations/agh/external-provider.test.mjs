import test from 'node:test';
import assert from 'node:assert/strict';
import { startExternalProvider } from './external-provider.mjs';

for (const providerId of ['openai-compatible','anthropic-compatible']) test(`${providerId} retains protocol token fields and isolates upstream credentials`,async()=>{
  const calls=[];const anthropic=providerId==='anthropic-compatible';
  const transport=await startExternalProvider({providerId,baseUrl:anthropic?'https://fixture.example':'https://fixture.example/v1',model:'fixture-model',apiKey:'fixture-account-key'}, {maxRequests:1,fetchImpl:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return new Response('data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});}});
  try{
    const request=()=>fetch(transport.baseUrl+(anthropic?'/v1/messages':'/chat/completions'),{method:'POST',headers:{'content-type':'application/json',...(anthropic?{'x-api-key':transport.token}:{authorization:`Bearer ${transport.token}`})},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'查找法兰'}],...(anthropic?{max_tokens:16000}:{max_completion_tokens:16000}),tools:anthropic?[{name:'shell',input_schema:{}},{name:'industrial_search_catalog',input_schema:{}}]:[{type:'function',function:{name:'shell'}},{type:'function',function:{name:'industrial_search_catalog'}}]})});
    assert.equal((await request()).status,200);assert.equal(calls.length,1);
    assert.equal(calls[0].body[anthropic?'max_tokens':'max_completion_tokens'],8192);
    assert.equal(calls[0].body[anthropic?'max_completion_tokens':'max_tokens'],undefined);
    assert.equal(calls[0].body.tools.length,1);
    assert.equal(calls[0].options.headers[anthropic?'x-api-key':'authorization'],anthropic?'fixture-account-key':'Bearer fixture-account-key');
    assert.ok(!JSON.stringify(calls).includes(transport.token));
    assert.equal((await request()).status,429);assert.equal(calls.length,1);assert.equal(transport.requests,1);
  }finally{await transport.close();}
});

for (const thinkingDisabled of [false, true]) test(`thinking switch ${thinkingDisabled ? 'disables' : 'leaves'} model thinking in forwarded requests`,async()=>{
  const calls=[];
  const transport=await startExternalProvider({providerId:'openai-compatible',baseUrl:'https://fixture.example/v1',model:'MiniMax-M3',apiKey:'fixture-account-key',thinkingDisabled}, {maxRequests:1,fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[]});}});
  try{
    const response=await fetch(transport.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${transport.token}`},body:JSON.stringify({model:'MiniMax-M3',messages:[{role:'user',content:'查找法兰'}],reasoning_effort:'high'})});
    assert.equal(response.status,200);
    if(thinkingDisabled){assert.deepEqual(calls[0].thinking,{type:'disabled'});assert.equal(calls[0].reasoning_effort,undefined);}
    else{assert.equal(calls[0].thinking,undefined);assert.equal(calls[0].reasoning_effort,'high');}
  }finally{await transport.close();}
});
