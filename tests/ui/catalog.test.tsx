import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import Catalog from '../../src/Catalog';
import type{Asset} from '../../src/types';
vi.mock('../../src/three-utils',()=>({thumbnail:vi.fn().mockResolvedValue('data:image/png;base64,AA==')}));
const assets:Asset[]=Array.from({length:45},(_,i)=>({id:`part-${i}`,displayCode:`FG-${String(i+1).padStart(3,'0')}`,name:`工程件${i+1}`,category:i<20?'机器人':'传动件',format:i<8?'STL':'STEP',thumbnailUrl:'/thumb.png',modelUrl:'/model.glb'}));
describe('asset filters',()=>{
 it('shows removable format filter and total, retaining stable IDs after narrowing and clearing',async()=>{
  const user=userEvent.setup();render(<Catalog assets={assets} onSelect={()=>{}} onUpload={()=>{}}/>);
  expect(screen.getByRole('status')).toHaveTextContent('显示 45/45 资产');
  const codeBefore=document.querySelector('[data-asset-id="part-7"]')?.getAttribute('data-asset-code');
  await user.click(screen.getByRole('button',{name:'筛选',exact:true}));
  await user.selectOptions(screen.getByLabelText('源文件格式'),'STL');
  expect(screen.getByRole('status')).toHaveTextContent('显示 8/45 资产');
  expect(screen.getByRole('button',{name:'全部资产 45'})).toBeInTheDocument();
  expect(document.querySelectorAll('.asset-card')).toHaveLength(8);
  expect(document.querySelector('[data-asset-id="part-7"]')?.getAttribute('data-asset-code')).toBe(codeBefore);
  await user.click(screen.getByRole('button',{name:'移除 STL 格式筛选'}));
  expect(screen.getByRole('status')).toHaveTextContent('显示 45/45 资产');
  await user.type(screen.getByRole('textbox',{name:'搜索资产'}),'FG-008');
  expect(screen.getByRole('status')).toHaveTextContent('显示 1/45 资产');
  expect(document.querySelector('[data-asset-id="part-7"]')).toBeInTheDocument();
 });
 it('keeps the code with its identity when the full input order changes',()=>{
  const{rerender}=render(<Catalog assets={assets} onSelect={()=>{}} onUpload={()=>{}}/>);
  rerender(<Catalog assets={[...assets].reverse()} onSelect={()=>{}} onUpload={()=>{}}/>);
  expect(document.querySelector('[data-asset-id="part-7"]')).toHaveAttribute('data-asset-code','FG-008');
  expect(within(document.querySelector('[data-asset-id="part-7"]') as HTMLElement).getByText('FG-008')).toBeInTheDocument();
 });
});
