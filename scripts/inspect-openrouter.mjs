import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
process.stdin.setRawMode?.(true);process.stdin.resume();
console.log('Ready for private model provider configuration on stdin (hidden).');
const config=await new Promise((resolve,reject)=>{let input='';const onData=chunk=>{input+=chunk.toString();if(input.length>16000)reject(new Error('Configuration too long'));if(input.includes('\n')){process.stdin.off('data',onData);process.stdin.pause();try{resolve(JSON.parse(input.slice(0,input.indexOf('\n'))));}catch{reject(new Error('Invalid JSON'));}}};process.stdin.on('data',onData);});
const response=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${config.apiKey}`}});
let data={};try{data=(await response.json()).data||{};}catch{}
const baseline={checkedAt:new Date().toISOString(),httpStatus:response.status,usage:data.usage??null,limit:data.limit??null,remaining:data.limit_remaining??null,usageDaily:data.usage_daily??null};
await fs.writeFile(path.join(root,'data/live-runner/key-baseline.json'),JSON.stringify(baseline,null,2),{mode:0o600});
console.log(JSON.stringify(baseline));
