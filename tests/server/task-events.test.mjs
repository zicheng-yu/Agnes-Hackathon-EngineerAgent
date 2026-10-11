import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readableAGHEvent} from '../../server/task-events.mjs';
test('pairs official tool events without treating assistant prose as tool activity',()=>{
 const calls=new Map();
 const call=readableAGHEvent({type:'tool/call',data:{toolUseId:'one',name:'industrial_geometry',args:{operation:'build',input:{name:'支架'}}}},calls);
 assert.equal(call.phase,'running');assert.equal(call.input,'生成模型 · 支架');
 const result=readableAGHEvent({type:'tool/result',data:{toolUseId:'one',structured:{success:true,manifest:{verification:{passed:false,checks:[{kind:'hole_pitch',axis:'x',diameter:8,expected:48,actual:24,passed:false}]}}}}},calls);
 assert.equal(result.toolName,'industrial_geometry');assert.equal(result.phase,'failed');assert.match(result.output,/未通过/);assert.match(result.output,/Ø8 孔距 X 图纸 48 \/ 实测 24 ✗/);
 const prose=readableAGHEvent({type:'assistant/message',data:{content:[{type:'text',text:'我已调用工具'},{type:'thinking',text:'private internal text'}]}});
 assert.equal(prose.type,'assistant');assert.equal(prose.toolUseId,undefined);assert.equal(prose.message,'我已调用工具');
 assert.equal(readableAGHEvent({type:'assistant/message',data:{content:null}}),null);
});
test('surfaces real errors and filters irrelevant streaming events',()=>{
 const result=readableAGHEvent({type:'tool/result',data:{toolUseId:'missing',isError:true}});
 assert.equal(result.phase,'failed');assert.equal(readableAGHEvent({type:'assistant/delta',data:{}}),null);
});
test('summarises clarification requests as paused input, not tool success prose',()=>{
 const calls=new Map();
 readableAGHEvent({type:'tool/call',data:{toolUseId:'c',name:'industrial_request_clarification',args:{question:'请提供板厚',missing:[{item:'厚度'}]}}},calls);
 const result=readableAGHEvent({type:'tool/result',data:{toolUseId:'c',structured:{success:true,status:'needs_input',missing:[{item:'厚度',evidence:'主视图标注为 ?'}]}}},calls);
 assert.equal(result.message,'请求补充资料');assert.equal(result.output,'需要补充：厚度（主视图标注为 ?）');
});
