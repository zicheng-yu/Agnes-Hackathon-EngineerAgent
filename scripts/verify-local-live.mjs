/** Explicit paid acceptance check; configured model key stays inside the local server. */
import fs from 'node:fs/promises';
if(!process.argv.includes('--paid')){console.log('Use --paid to run one metered task within the configured budget.');process.exit(0);}
const origin='http://127.0.0.1:4310';let cookie='';
async function call(route,body){const multipart=body instanceof FormData;const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{...(!multipart?{'content-type':'application/json'}:{}),origin}: {})},...(body?{body:multipart?body:JSON.stringify(body)}:{})});const set=response.headers.getSetCookie?.()[0];if(set)cookie=set.split(';')[0];const value=await response.json();if(!response.ok)throw new Error(value.message||value.error||String(response.status));return value;}
let health=await call('/api/health');
for(let i=0;i<15&&!health.modelConfigured;i++){await new Promise(r=>setTimeout(r,1000));health=await call('/api/health');}
if(!health.modelConfigured)throw new Error('Model executor is not ready.');
const drawing=process.argv.includes('--drawing');
let input={mode:'catalog_search',instruction:'请通过工程资产库检索法兰，列出匹配的编号、名称和用途。'};
if(drawing){const form=new FormData();form.append('file',new Blob([await fs.readFile('assets/evaluation/codex-assisted-EA-V01-20261010/drawing.png')],{type:'image/png'}),'EA-V01.png');const document=await call('/api/documents',form);input={mode:'reconstruct',instruction:'请依据附件图纸重建零件，调用工业 CAD 工具完成建模、验证和投影，返回可下载的 STEP 与 GLB 及检查结果。不要猜测未标明尺寸。',documentId:document.id,pages:[1]};}
const task=await call('/api/tasks',input);
console.log(JSON.stringify({id:task.id,status:task.status,model:health.model}));let last=task,lastCount=0;
for(let i=0;i<310;i++){
 await new Promise(r=>setTimeout(r,2000));last=await call('/api/tasks/'+task.id);
 if(last.events.length!==lastCount){lastCount=last.events.length;console.log(JSON.stringify({status:last.status,events:lastCount,last:last.events.at(-1)?.message,usage:last.usage}));}
 if(['completed','failed','cancelled'].includes(last.status))break;
}
await fs.mkdir('output/verification',{recursive:true});
if(drawing&&last.status==='completed'){
 last.artifactVerification=[];await fs.mkdir('output/verification/accepted-drawing',{recursive:true});
 for(const artifact of last.result?.publishedArtifacts||[]){
  if(!artifact.url?.startsWith(`/api/tasks/${task.id}/artifacts/`)||!artifact.name?.match(/^[\w.-]+$/))throw new Error('Unexpected artifact URL/name');
  const response=await fetch(origin+artifact.url,{headers:{cookie}});const bytes=Buffer.from(await response.arrayBuffer());
  if(!response.ok||!bytes.length||bytes.length!==artifact.bytes)throw new Error('Artifact download failed: '+artifact.name);
  if(artifact.name.endsWith('.step')&&!bytes.toString('utf8').startsWith('ISO-10303-21;'))throw new Error('Invalid STEP');
  if(artifact.name.endsWith('.glb')&&bytes.subarray(0,4).toString()!=='glTF')throw new Error('Invalid GLB');
  await fs.writeFile(`output/verification/accepted-drawing/${artifact.name}`,bytes);
  last.artifactVerification.push({name:artifact.name,bytes:bytes.length,status:response.status});
 }
 if(!last.artifactVerification.some(x=>x.name.endsWith('.step'))||!last.artifactVerification.some(x=>x.name.endsWith('.glb')))throw new Error('Missing model artifacts');
}
await fs.writeFile(`output/verification/local-openrouter-${drawing?'drawing':'catalog'}-acceptance.json`,JSON.stringify(last,null,2));
console.log(JSON.stringify({status:last.status,error:last.error,usage:last.usage,items:last.result?.catalogResults?.items?.length,answer:last.result?.answer?.slice(0,200)}));
if(last.status!=='completed')process.exitCode=1;
