import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TaskScheduler} from '../../server/task-scheduler.mjs';
import {createTaskHistory,historyPage} from '../../server/task-history.mjs';
import {drawingInputError} from '../../server/document-validation.mjs';
import {createCatalogCache} from '../../server/catalog-cache.mjs';
import {runAGHTask} from '../../server/agh-bridge.mjs';
const tick=()=>new Promise(r=>setImmediate(r));

test('single executor queues jobs and cancellation never starts a queued paid request',async()=>{
 const scheduler=new TaskScheduler({capacity:2});let release;const calls=[];
 const first=scheduler.submit('one',async signal=>{calls.push('one');await new Promise(r=>{release=r;signal.addEventListener('abort',r,{once:true});});},async()=>{});
 const second=scheduler.submit('two',async()=>{calls.push('two');},async()=>{calls.push('two-cancelled');});
 assert.equal(scheduler.available,false);assert.throws(()=>scheduler.submit('three',async()=>{},async()=>{}));
 await tick();assert.deepEqual(calls,['one']);await scheduler.cancel('two');await second;
 assert.deepEqual(calls,['one','two-cancelled']);release();await first;assert.equal(scheduler.available,true);await scheduler.stop();
});
test('running cancellation retains its slot until cleanup settles and shutdown cancels the rest',async()=>{
 const scheduler=new TaskScheduler();let cleaned=false,release;
 const first=scheduler.submit('one',async signal=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await new Promise(r=>release=r);cleaned=true;},async()=>{});
 await tick();const calls=[];const second=scheduler.submit('two',async()=>calls.push('started'),async reason=>calls.push(reason));
 await scheduler.cancel('one');await tick();assert.equal(scheduler.active,1);assert.deepEqual(calls,[]);
 const stopped=scheduler.stop();await tick();assert.deepEqual(calls,['shutdown']);release();await Promise.all([first,second,stopped]);assert.equal(cleaned,true);assert.equal(scheduler.active,0);
});
test('restart preserves evidence, marks unfinished records interrupted, and pages summaries without events',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-history-'));
 try{
  for(let i=0;i<25;i++)await fs.writeFile(path.join(root,`${i}.json`),JSON.stringify({id:String(i),mode:'reconstruct',createdAt:new Date(1000*i).toISOString(),status:i===24?'running':'completed',instruction:'原始输入',events:[{message:'已收到证据'}],result:{answer:'完整大结果',outcome:'completed'}}));
  const history=await createTaskHistory(root),first=history.list({limit:'20'}),second=history.list({limit:'20',offset:'20'});
  assert.equal(first.total,25);assert.equal(first.hasMore,true);assert.equal(second.items.length,5);assert.equal(new Set([...first.items,...second.items].map(t=>t.id)).size,25);
  assert.equal(first.items[0].status,'interrupted');assert.equal(first.items[0].events,undefined);assert.equal(first.items[0].result.answer,undefined);
  const recovered=await history.get('24');assert.equal(recovered.events[0].message,'已收到证据');assert.match(recovered.error,/不会自动/);
  const current={...recovered,status:'completed'};await Promise.all([history.save(current),history.save({...current,revision:2})]);assert.equal((await history.get('24')).revision,2);assert.equal(history.list({}).items[0].status,'completed');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('unreadable documents, duplicate pages and out of bounds pages cannot pass admission',()=>{
 const image={mime:'image/png'},pdf={mime:'application/pdf',pageCount:3};
 assert.equal(drawingInputError(image,[1]),'');assert.match(drawingInputError(image,[999]),/共有 1 页/);
 assert.match(drawingInputError({...pdf,error:'corrupt'},[1]),/重新上传/);
 for(const pages of [[1,1],[0],[1,2,3,4,5],['1'],[1.2],[]])assert.ok(drawingInputError(pdf,pages));
 assert.ok(drawingInputError(pdf,[4]));assert.equal(drawingInputError(pdf,[3,1]),'');
});
test('cancelling an actual child uses IPC and waits for its cleanup result',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-ipc-'));
 try{
  await fs.mkdir(path.join(root,'integrations/agh'),{recursive:true});
  await fs.writeFile(path.join(root,'integrations/agh/run-external-task.mjs'),`process.on('message',message=>{if(message.type==='cancel'){console.log(JSON.stringify({type:'result',success:false,cleaned:true}));process.disconnect();}});process.send({type:'ready'});`);
  const controller=new AbortController();
  const promise=runAGHTask({root,taskFile:'unused',settings:{baseUrl:'http://127.0.0.1',model:'test',apiKey:''},signal:controller.signal});
  controller.abort();const result=await promise;assert.equal(result.cleaned,true);assert.equal(result.success,false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('catalog cache shares concurrent reads and invalidates when the manifest changes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-cache-'));let reads=0,time=0;
 try{
  await fs.mkdir(path.join(root,'assets'),{recursive:true});await fs.writeFile(path.join(root,'assets/a.json'),'one');
  const read=createCatalogCache(root,{now:()=>time,interval:1000,read:async()=>{reads++;await tick();return [{id:'one',manifest:'assets/a.json'}];}});
  const [a,b]=await Promise.all([read(),read()]);assert.equal(a,b);assert.equal(reads,1);
  time=1001;await read();assert.equal(reads,1);await fs.writeFile(path.join(root,'assets/a.json'),'changed-longer');time=2002;await read();assert.equal(reads,2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
