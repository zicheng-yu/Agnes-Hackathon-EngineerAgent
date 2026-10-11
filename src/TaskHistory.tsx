import {useEffect,useState} from 'react';
import {Activity,ChevronRight,Download,LoaderCircle,X} from 'lucide-react';
import {api} from './api';
import {TaskRecordView,taskLabelFor,type WorkspaceTask} from './TaskWorkspace';
import type {Asset} from './types';
const modeLabels:Record<string,string>={reconstruct:'图纸重建',order_review:'订单评审',catalog_search:'零件检索'};
const pending=(task:WorkspaceTask)=>['running','queued','preparing','pending'].includes(task.status);
const modelOf=(task:WorkspaceTask)=>String(task.usage?.model||task.result?.model||'—');
type HistoryPage={items:WorkspaceTask[];total:number;hasMore:boolean};
export default function TaskHistory({assets,onSelectAsset}:{assets:Asset[];onSelectAsset:(a:Asset)=>void}) {
  const [tasks,setTasks]=useState<WorkspaceTask[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [page,setPage]=useState(0),[total,setTotal]=useState(0),[hasMore,setHasMore]=useState(false);
  const [selected,setSelected]=useState<WorkspaceTask|null>(null),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,busy=false;
    const load=async()=>{
      if(busy||controller.signal.aborted)return;busy=true;
      try {
        const response=await api<HistoryPage|WorkspaceTask[]>(`/api/tasks?summary=1&offset=${page*20}&limit=20`,{signal:controller.signal});
        const items=Array.isArray(response)?response.filter(t=>t.mode!=='geometry'):response.items;
        if(controller.signal.aborted)return;
        setTasks(items);setTotal(Array.isArray(response)?items.length:response.total);setHasMore(!Array.isArray(response)&&response.hasMore);setError('');
        if(items.some(pending))timer=setTimeout(load,5000);
      }catch(cause){if(!controller.signal.aborted){setError((cause as Error).message);timer=setTimeout(load,5000);}}
      finally {busy=false;if(!controller.signal.aborted)setLoading(false);}
    };
    const reconnect=()=>{if(!document.hidden){clearTimeout(timer);void load();}};
    setLoading(true);void load();document.addEventListener('visibilitychange',reconnect);window.addEventListener('online',reconnect);
    return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',reconnect);window.removeEventListener('online',reconnect);};
  },[page]);
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const task=await api<WorkspaceTask>(`/api/tasks/${encodeURIComponent(selected.id)}`,{signal:controller.signal});if(!controller.signal.aborted){setSelected(task);setDetailError('');setDetailLoading(false);if(pending(task))timer=setTimeout(load,2000);}}catch(cause){if(!controller.signal.aborted){setDetailError((cause as Error).message);setDetailLoading(false);timer=setTimeout(load,5000);}}};
    setDetailLoading(true);setDetailError('');void load();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setSelected(null);};window.addEventListener('keydown',key);
    return()=>{controller.abort();clearTimeout(timer);window.removeEventListener('keydown',key);};
  },[selected?.id]);
  return <>
    <div className="page-title history-heading"><div><h1>历史记录</h1><p>每次 AGH 任务的输入、工具调用、检查结果与产物。导出的 ZIP 含原生执行记录、输入图纸、最终模型与检查结果。</p></div><div className="history-actions"><span className="muted">共 {total} 条</span>{total>0?<a className="primary-button" href="/api/history/export" download><Download size={16}/>导出全部执行记录</a>:null}</div></div>
    {error?<p className="inline-error" role="alert">{error} 正在自动重连，已有记录会保留。</p>:null}
    {loading?<p role="status"><LoaderCircle className="spin" size={16}/>正在读取记录…</p>:null}
    {!loading&&!error&&!tasks.length?<div className="empty-state bordered"><Activity size={34}/><h3>还没有历史记录</h3><p>在任务工作台运行任务后，这里会保留 AGH 的真实调用与产物。</p></div>:tasks.length?<>
      <div className="panel history-panel" aria-busy={loading}><table className="run-table"><thead><tr>{['任务','类型','模型','状态','开始时间','记录'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{tasks.map(t=><tr key={t.id}>
        <td data-label="任务"><strong>{t.title}</strong>{t.instruction?<small className="run-excerpt">{t.instruction.slice(0,80)}</small>:null}<small className="mono">{t.id.slice(0,8)}{t.revision&&t.revision>1?` · 第 ${t.revision} 轮`:''}</small></td>
        <td data-label="类型">{modeLabels[t.mode||'']||'—'}</td><td data-label="模型" className="mono">{modelOf(t)}</td><td data-label="状态"><span className={`run-status ${t.result?.outcome==='needs_input'?'needs-input':t.status}`}>{taskLabelFor(t)}</span></td>
        <td data-label="开始时间" className="mono">{t.createdAt?new Date(t.createdAt).toLocaleString('zh-CN',{hour12:false}):'—'}</td><td data-label="记录"><button className="text-button" onClick={()=>setSelected(t)} aria-label={`查看记录：${t.title}`}>查看 <ChevronRight size={14}/></button></td>
      </tr>)}</tbody></table></div>
      <nav className="history-pagination" aria-label="历史记录分页"><button className="secondary-button" disabled={page===0||loading} onClick={()=>setPage(n=>n-1)}>上一页</button><span>第 {page+1} 页 · 共 {total} 条</span><button className="secondary-button" disabled={!hasMore||loading} onClick={()=>setPage(n=>n+1)}>下一页</button></nav>
    </>:null}
    {selected?<div className="modal-backdrop" onClick={()=>setSelected(null)}><section className="trace-modal task-workspace" role="dialog" aria-modal="true" aria-label="历史记录" onClick={e=>e.stopPropagation()}><header><div><span className="task-run-kicker">{modeLabels[selected.mode||'']||'任务'} · AGH · {modelOf(selected)}</span><h2>{selected.title}</h2></div><button className="icon-button" aria-label="关闭记录" onClick={()=>setSelected(null)}><X/></button></header><div className="trace-content">
      {selected.parentTaskId?<p className="task-notice">第 {selected.revision||2} 轮补充 · <button className="text-button" onClick={()=>setSelected({id:selected.parentTaskId!,status:'completed'})}>查看上一轮记录</button></p>:null}
      {detailLoading?<p role="status">正在读取完整记录…</p>:null}{detailError?<p className="inline-error" role="alert">{detailError}</p>:null}
      {!detailLoading&&!detailError?<TaskRecordView task={selected} assets={assets} onSelectAsset={onSelectAsset}/>:null}
    </div></section></div>:null}
  </>;
}
