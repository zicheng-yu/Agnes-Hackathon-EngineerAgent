import fs from 'node:fs/promises';
import path from 'node:path';
export function taskSummary(task) {
  const {id,title,status,mode,createdAt,completedAt,parentTaskId,revision,rootTaskId,error,cancelRequested}=task;
  const instruction=String(task.instruction||'').split(/\n/).map(x=>x.trim()).find(x=>x&&!/^(数据来源|内部编号\s*\|)/.test(x))?.slice(0,120)||'';
  return {id,title,status,mode,createdAt,completedAt,parentTaskId,revision,rootTaskId,error,cancelRequested,instruction,usage:{model:task.usage?.model||task.result?.model},result:{outcome:task.result?.outcome,engineeringStatus:task.result?.engineeringStatus,runtimeStatus:task.result?.runtimeStatus,runtimeWarning:task.result?.runtimeWarning}};
}
export function historyPage(items, query = {}) {
  const limit=Math.min(100,Math.max(1,Number.parseInt(query.limit,10)||20));
  const offset=Math.max(0,Number.parseInt(query.offset,10)||0);
  const sorted=items.filter(t=>t.mode!=='geometry').sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||b.id.localeCompare(a.id));
  return {items:sorted.slice(offset,offset+limit).map(taskSummary),total:sorted.length,offset,limit,hasMore:offset+limit<sorted.length};
}
export async function createTaskHistory(directory) {
  const index=new Map(), writes=new Map();
  async function save(task) {
    if(!/^[\w-]+$/.test(task.id))throw new Error('Invalid task ID');
    index.set(task.id,taskSummary(task));
    const json=JSON.stringify(task,null,2);
    const next=(writes.get(task.id)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const target=path.join(directory,task.id+'.json'), temporary=target+'.tmp';
      await fs.writeFile(temporary,json);await fs.rename(temporary,target);
    });
    writes.set(task.id,next);try{await next;}finally{if(writes.get(task.id)===next)writes.delete(task.id);}
  }
  for(const name of (await fs.readdir(directory)).filter(name=>/^[\w-]+\.json$/.test(name))) {
    let task;try{task=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}catch{continue;}
    if(task?.id!==name.slice(0,-5) || task.mode==='geometry')continue;
    if(['running','queued','preparing'].includes(task.status)) {
      task.status='interrupted';task.completedAt=new Date().toISOString();
      task.error='服务曾中断，执行状态需要核对。已保留现有记录，不会自动重新调用模型。';
      task.events=[...(task.events||[]),{time:task.completedAt,type:'warning',message:task.error}];
      await save(task);
    } else index.set(task.id,taskSummary(task));
  }
  return {save,list:query=>historyPage([...index.values()],query),async get(id){return JSON.parse(await fs.readFile(path.join(directory,id+'.json'),'utf8'));}};
}
