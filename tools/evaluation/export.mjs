import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..');
const reviewed=JSON.parse(await fs.readFile(path.join(root,'evaluation/reviewed.json'),'utf8'));
const destination=path.join(root,'assets/evaluation');await fs.mkdir(destination,{recursive:true});
const sourceRuns=await fs.realpath(path.join(root,'data/runs'));
function clean(value){
 if(typeof value==='string')return value.replaceAll(root+'/','').replace(/sk-[A-Za-z0-9_-]{24,}/g,'[REDACTED]');
 if(Array.isArray(value))return value.filter(item=>item?.type!=='thinking').map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['apiKey','authorization','accessToken','secret','token','api_key','thinking','reasoning','signature','encryptedContent'].includes(key)).map(([key,item])=>[key,clean(item)]));
 return value;
}
const report={model:'Agnes 3.0 Flash / Codex 外部协助',aghCommit:'cde816b88c737b9fd04e7ef55b899e7b4cd55eb7',scopeNote:'这是开发迭代记录，含同图复测；独立验收与工具状态分开。Codex外部协助单独标记，耗时不与自主模型直接比较。',runs:[]};
for(const item of reviewed.runs){
 const source=path.join(root,'evaluation/runs',item.source);const evidence=JSON.parse(await fs.readFile(path.join(source,'evidence.json'),'utf8'));
 const records=(await fs.readFile(path.join(source,'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const events=records.filter(row=>row.type==='agh_event').map(row=>row.event);const toolCalls=new Map();const tools=[];
 for(const e of events){if(e.type==='tool/call'){const entry={id:e.data.toolUseId,name:e.data.name,operation:e.data.args?.operation,status:'failed',summary:'没有收到成功结果'};toolCalls.set(entry.id,entry);tools.push(entry);}if(e.type==='tool/result'){const entry=toolCalls.get(e.data.toolUseId);if(entry){const result=e.data.structured;const failed=e.data.isError||result?.success===false||result?.manifest?.verification?.passed===false;entry.status=failed?'failed':'passed';entry.summary=failed?'工具返回错误或检查未通过':result?.manifest?'所列几何检查 / 操作完成':'实际业务工具已返回';}}}
 const caseDir=path.join(destination,item.source);await fs.mkdir(caseDir,{recursive:true});const artifacts={};
 const lastBuilt=events.filter(e=>e.type==='tool/result').map(e=>e.data?.structured).filter(v=>v?.manifest?.files?.step && ['build','patch','assembly'].includes(v.manifest.operation)).at(-1);
 const geometry=evidence.result?.geometryRuns?.at(-1) || (lastBuilt ? {runId:lastBuilt.runId,files:lastBuilt.manifest.files} : null);
 for(const [key,file] of Object.entries(geometry?.files||{})){
  if(!['step','glb'].includes(key)||typeof file!=='string')continue;
  const actual=await fs.realpath(file);if(!actual.startsWith(sourceRuns+path.sep))throw new Error('Unexpected geometry scope');
  const name=path.basename(actual);await fs.copyFile(actual,path.join(caseDir,name));artifacts[key]=`/assets/evaluation/${item.source}/${name}`;
 }
 if(geometry?.runId){const manifest=JSON.parse(await fs.readFile(path.join(sourceRuns,geometry.runId,'manifest.json'),'utf8'));delete manifest.files;await fs.writeFile(path.join(caseDir,'manifest.json'),JSON.stringify(clean(manifest),null,2));artifacts.manifest=`/assets/evaluation/${item.source}/manifest.json`;}
 const publicTrace=events.filter(e=>['tool/call','tool/result','assistant/message','turn/start','turn/end'].includes(e.type)).map(clean);
 await fs.writeFile(path.join(caseDir,'trace.jsonl'),publicTrace.map(e=>JSON.stringify(e)).join('\n'));artifacts.trace=`/assets/evaluation/${item.source}/trace.jsonl`;
 if(item.source.includes('vision') || item.source.includes('repair') || item.source.includes('codex-assisted')) {
  const sourceName=item.source.includes('missing')?'EA-V01-B.png':'EA-V01-A.png';
  await fs.copyFile(path.join(root,'data/uploads/evaluation-20261009',sourceName),path.join(caseDir,'drawing.png'));artifacts.drawing=`/assets/evaluation/${item.source}/drawing.png`;
 }
 const session=records.find(row=>row.type==='session');
 report.runs.push({...item,id:item.source,source:undefined,model:evidence.model,pluginVersion:session?.plugin?.version,pluginIntegrity:session?.plugin?.integrity,durationSeconds:evidence.durationSeconds,toolCalls:tools.length,summary:item.summary,tools:tools.map(({id,...rest})=>rest),artifacts,inputSha256:evidence.inputSha256,traceSha256:createHash('sha256').update(JSON.stringify(publicTrace)).digest('hex')});
}
report.runs.sort((a,b)=>Number(b.phase==='improved')-Number(a.phase==='improved'));
await fs.writeFile(path.join(destination,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({reviewedRuns:report.runs.length,outcomes:report.runs.map(r=>({title:r.title,outcome:r.outcome}))}));
