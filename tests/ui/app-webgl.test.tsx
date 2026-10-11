import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {it,expect,vi} from 'vitest';
import App from '../../src/App';
import {api} from '../../src/api';
vi.mock('../../src/api',()=>({api:vi.fn(),jsonPost:(value:unknown)=>({method:'POST',body:JSON.stringify(value)})}));
it('keeps the asset modal and other workspace pages usable when WebGL is disabled',async()=>{
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
 vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.mocked(api).mockImplementation(async(url:string)=>{
  if(url==='/api/catalog')return [{id:'test-assembly',displayCode:'FG-001',name:'测试装配体',category:'装配',format:'STEP',modelUrl:'/model.glb',thumbnailUrl:'/thumb.png',manifestUrl:'/manifest.json'}] as never;
  if(url==='/api/health')return {cad:true,agh:true,modelConfigured:false,model:'',version:'test'} as never;
  if(url==='/assets/demo-cases/cases.json')return {cases:[]} as never;
  return {} as never;
 });
 const user=userEvent.setup();render(<App/>);
 expect(screen.getByRole('form',{name:'工程任务输入'})).toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'工程资产库',exact:true}));
 expect(screen.getByRole('heading',{name:'工程资产库',level:1})).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'历史记录',exact:true})).toBeInTheDocument();
 await user.click(await screen.findByRole('button',{name:/测试装配体/}));
 expect(screen.getByRole('dialog',{name:'测试装配体'})).toBeInTheDocument();
 expect(await screen.findByText(/WebGL/)).toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'关闭模型详情'}));
 await user.click(screen.getByRole('button',{name:'订单评审',exact:true}));
 expect(screen.getByRole('heading',{name:'订单评审',level:1})).toBeInTheDocument();
 expect(screen.getByRole('textbox',{name:'这次需要完成什么？'})).toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:'任务类型'})).not.toBeInTheDocument();
});
