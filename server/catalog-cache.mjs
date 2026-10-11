import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog } from './catalog.mjs';
export function createCatalogCache(root, {read = loadCatalog, now = Date.now, interval = 1000} = {}) {
  let cached, stamp='', checked=-Infinity, pending;
  let files=['assets/catalog/catalog.json','assets/generated/catalog.json','assets/asset-codes.json'];
  const signature=async()=>JSON.stringify(await Promise.all(files.map(async name=>{
    try {const s=await fs.stat(path.resolve(root,name));return [name,s.mtimeMs,s.size];}catch{return [name,null];}
  })));
  return async()=>{
    if(pending)return pending;
    if(cached && now()-checked<interval)return cached;
    pending=(async()=>{
      const next=await signature();
      if(!cached || next!==stamp) {
        cached=await read(root);
        files=[...new Set([...files.slice(0,3),...cached.map(a=>a.manifest).filter(v=>typeof v==='string')])];
        stamp=await signature();
      }
      checked=now();return cached;
    })();
    try{return await pending;}finally{pending=null;}
  };
}
