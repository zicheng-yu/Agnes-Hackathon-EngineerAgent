import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach,it,expect,vi} from 'vitest';
import App from '../../src/App';
import TaskWorkspace from '../../src/TaskWorkspace';
import TaskHistory from '../../src/TaskHistory';
import {api} from '../../src/api';
vi.mock('../../src/api',()=>({api:vi.fn(),jsonPost:(value:unknown)=>({method:'POST',body:JSON.stringify(value)})}));
vi.mock('../../src/Viewer',()=>({default:()=> <div>模型视图</div>}));
const health={cad:true,agh:true,modelConfigured:true,model:'test',version:'test',taskCancellation:true,taskRevisions:true};
const mock=vi.mocked(api);
const mount=()=>render(<TaskWorkspace health={health} assets={[]} onSelectAsset={()=>{}} onOpenSettings={()=>{}}/>);
beforeEach(()=>{sessionStorage.clear();mock.mockReset();mock.mockImplementation(async url=>{
 if(url==='/api/health')return health as never;if(url==='/api/catalog')return [] as never;
 if(url==='/assets/demo-cases/cases.json')return {cases:[]} as never;
 if(url==='/api/documents')return {id:'image',name:'image.png',mime:'image/png',pageCount:1} as never;
 return {id:'task',status:'completed',events:[],result:{answer:'完成'}} as never;
});});
it('rejects damaged uploads and catches out-of-range image pages before submission',async()=>{
 const user=userEvent.setup(),view=mount();await user.type(screen.getByRole('textbox',{name:'这次需要完成什么？'}),'重建零件');
 mock.mockRejectedValueOnce(new Error('文件已损坏'));
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['bad'],'bad.pdf')]}});
 expect(await screen.findByRole('alert')).toHaveTextContent('文件已损坏');expect(screen.getByRole('button',{name:'开始任务'})).toBeDisabled();
 fireEvent.change(view.container.querySelector('input[type=file]')!,{target:{files:[new File(['image'],'image.png')]}});await screen.findByText('image.png');
 fireEvent.change(screen.getByRole('textbox',{name:'图纸页码'}),{target:{value:'999'}});
 expect(screen.getByRole('alert')).toHaveTextContent('共有 1 页');expect(screen.getByRole('button',{name:'开始任务'})).toBeDisabled();
 expect(mock.mock.calls.some(([url])=>url==='/api/tasks')).toBe(false);
});
it('clears the connection warning after an online event succeeds',async()=>{
 let offline=true;mock.mockImplementation(async url=>{if(url==='/api/health'){if(offline)throw new Error('无法连接本地服务');return health as never;}if(url==='/api/catalog')return [] as never;return {cases:[]} as never;});
 render(<App/>);await screen.findByText(/连接恢复后将自动更新/);offline=false;fireEvent(window,new Event('online'));
 await waitFor(()=>expect(screen.queryByText(/连接恢复后将自动更新/)).not.toBeInTheDocument());
});
it('shows direct Agnes cancellation and uses the server cancellation result',async()=>{
 mock.mockImplementation(async (url,options)=>{if(url==='/assets/demo-cases/cases.json')return {cases:[]} as never;if(url==='/api/tasks')return {id:'cancel-me',status:'queued',events:[]} as never;if(url.endsWith('/cancel'))return {id:'cancel-me',status:'cancelled',events:[]} as never;return {id:'cancel-me',status:'queued',events:[]} as never;});
 const user=userEvent.setup();mount();await user.selectOptions(screen.getByRole('combobox',{name:'任务类型'}),'catalog_search');await user.type(screen.getByRole('textbox',{name:'这次需要完成什么？'}),'查找法兰');await user.click(screen.getByRole('button',{name:'开始任务'}));
 await user.click(await screen.findByRole('button',{name:'取消排队'}));expect(await screen.findByRole('heading',{name:'已停止'})).toBeVisible();expect(mock.mock.calls.some(([url])=>url==='/api/tasks/cancel-me/cancel')).toBe(true);
});
it('automatically reconnects task records without re-posting the paid task',async()=>{
 let calls=0,posts=0;
 mock.mockImplementation(async(url)=>{if(url==='/assets/demo-cases/cases.json')return {cases:[]} as never;if(url==='/api/tasks'){posts++;return {id:'retry',status:'running',events:[]} as never;}if(++calls===1)throw new Error('短暂断线');return {id:'retry',status:'completed',events:[],result:{answer:'已自动恢复'}} as never;});
 mount();fireEvent.change(screen.getByRole('combobox',{name:'任务类型'}),{target:{value:'catalog_search'}});fireEvent.change(screen.getByRole('textbox',{name:'这次需要完成什么？'}),{target:{value:'查询'}});fireEvent.click(screen.getByRole('button',{name:'开始任务'}));
 await screen.findByText(/正在自动重连/);fireEvent(window,new Event('online'));expect(await screen.findByText('已自动恢复')).toBeVisible();expect(posts).toBe(1);
});
it('loads paged summaries, then fetches the full selected record',async()=>{
 mock.mockImplementation(async url=>{
  if(url.startsWith('/api/tasks?'))return {items:[{id:url.includes('offset=20')?'second':'first',title:url.includes('offset=20')?'第二页任务':'第一页任务',status:'completed',mode:'order_review'}],total:21,hasMore:!url.includes('offset=20')} as never;
  return {id:'first',status:'completed',title:'第一页任务',events:[],result:{answer:'完整结果只在查看时出现'}} as never;
 });
 const user=userEvent.setup();render(<TaskHistory assets={[]} onSelectAsset={()=>{}}/>);await screen.findByText('第一页任务');expect(mock.mock.calls.some(([url])=>url==='/api/tasks/first')).toBe(false);
 await user.click(screen.getByRole('button',{name:'查看记录：第一页任务'}));expect(await screen.findByText('完整结果只在查看时出现')).toBeVisible();await user.click(screen.getByRole('button',{name:'关闭记录'}));await user.click(screen.getByRole('button',{name:'下一页'}));expect(await screen.findByText('第二页任务')).toBeVisible();
});
it('submits clarification as a linked revision preserving original requirements',async()=>{
 const posts:any[]=[];mock.mockImplementation(async(url,options)=>{
  if(url==='/assets/demo-cases/cases.json')return {cases:[]} as never;
  if(url==='/api/tasks'){posts.push(JSON.parse(String(options?.body)));return posts.length===1?{id:'parent',status:'completed',events:[],result:{outcome:'needs_input',clarification:{question:'缺少规格',missing:[]}}} as never:{id:'child',parentTaskId:'parent',revision:2,status:'completed',events:[],result:{answer:'补充后已完成'}} as never;}
  throw new Error(url);
 });
 const user=userEvent.setup();mount();await user.selectOptions(screen.getByRole('combobox',{name:'任务类型'}),'order_review');await user.type(screen.getByRole('textbox',{name:'这次需要完成什么？'}),'采购原要求');await user.click(screen.getByRole('button',{name:'开始任务'}));await screen.findByText(/发送的内容将作为补充资料/);await user.type(screen.getByRole('textbox',{name:'这次需要完成什么？'}),'规格为 M10');await user.click(screen.getByRole('button',{name:'开始任务'}));
 expect(await screen.findByText('补充后已完成')).toBeVisible();expect(posts[1].parentTaskId).toBe('parent');expect(posts[1].instruction).toContain('采购原要求');expect(posts[1].instruction).toContain('规格为 M10');
});
