#!/usr/bin/env node
/** Real AGH native OpenAI/Anthropic routing and industrial tools; fake providers only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { projectRoot, integration } from './common.mjs';
import { industrialToolNames } from './cloud-runner-protocol.mjs';

const reports = [];
for (const providerId of ['agnes-ai','openai-compatible','anthropic-compatible']) {
  const anthropic = providerId === 'anthropic-compatible'; let mainRequests=0, allRequests=0;
  const fixtureKey = 'fixture-external-key-not-a-real-account';
  const server = createServer(async (request,response) => {
    if(request.method!=='POST'){response.writeHead(404).end();return;}
    try {
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
      assert.equal(request.url, anthropic?'/v1/messages':'/v1/chat/completions');
      assert.equal(anthropic?request.headers['x-api-key']:request.headers.authorization,anthropic?fixtureKey:`Bearer ${fixtureKey}`);
      if(anthropic)assert.equal(request.headers['anthropic-version'],'2023-06-01');
      assert.ok((body.tools||[]).every(tool=>industrialToolNames.includes(anthropic?tool.name:tool.function?.name)));
      const main=Boolean(body.tools?.length);if(main)mainRequests++;allRequests++;
      const tool=main&&mainRequests===1;
      response.writeHead(200,{'content-type':'text/event-stream'});
      if(anthropic){
        const send=(event,data)=>response.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
        send('message_start',{message:{id:`fixture-${allRequests}`,type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:1}}});
        send('content_block_start',{index:0,content_block:tool?{type:'tool_use',id:'fixture-tool',name:'industrial_search_catalog',input:{}}:{type:'text',text:''}});
        send('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:'{"query":"法兰","limit":3}'}:{type:'text_delta',text:main?'Actual AGH tool verification completed.':'检索验证'}});
        send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}});send('message_stop',{});response.end();
      }else{
        const base={id:`fixture-${allRequests}`,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model};
        const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'fixture-tool',type:'function',function:{name:'industrial_search_catalog',arguments:'{"query":"法兰","limit":3}'}}]}:{role:'assistant',content:main?'Actual AGH tool verification completed.':'检索验证'};
        response.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
        response.end(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})}\n\ndata: [DONE]\n\n`);
      }
    }catch(error){response.writeHead(500).end('Fake provider protocol assertion failed.');console.error(error.message);}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{
    const folder=resolve(projectRoot,'data/uploads',`external-smoke-${randomUUID()}`);await mkdir(folder,{recursive:true});const input=resolve(folder,'task.json');await writeFile(input,JSON.stringify({mode:'catalog_search',prompt:'检索法兰并报告实际匹配。',images:[]}));
    const baseUrl=`http://127.0.0.1:${server.address().port}`+(anthropic?'':'/v1');
    const {stdout}=await promisify(execFile)(process.execPath,[resolve(integration,'run-external-task.mjs'),'--input',input],{cwd:projectRoot,timeout:180000,maxBuffer:4*1024*1024,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR||'/tmp',AGH_ALLOW_MODEL_RUN:'1',AGNES_PROVIDER_ID:providerId,AGNES_BASE_URL:baseUrl,AGNES_MODEL:providerId==='agnes-ai'?'agnes-3.0-flash':'fixture-custom-model',AGNES_API_KEY:fixtureKey,AGH_VISION_ENABLED:'1',AGH_INDUSTRIAL_API:process.env.AGH_INDUSTRIAL_API||'http://127.0.0.1:4310'}});
    assert.ok(!stdout.includes(fixtureKey));const rows=stdout.trim().split('\n').map(line=>JSON.parse(line));const result=rows.findLast(row=>row.type==='result');
    assert.equal(result?.success,true,JSON.stringify(result?.error));assert.equal(result.catalogResults.source,'local_catalog');assert.equal(result.usage.billingMode,'external');assert.equal(result.usage.costUsd,null);assert.ok(result.usage.promptTokens>=200);assert.equal(mainRequests,2);
    reports.push({providerId,success:true,nativeProtocol:anthropic?'anthropic-messages':'openai-completions',mainRequests,allRequests,promptTokens:result.usage.promptTokens,costUsd:null});
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
}
console.log(JSON.stringify({success:true,paidProviderCalls:0,reports},null,2));
