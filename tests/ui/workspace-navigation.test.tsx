import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../../src/App';
import ModelSetupNotice from '../../src/ModelSetupNotice';
import { api } from '../../src/api';
import type { Health } from '../../src/types';

vi.mock('../../src/api', () => ({ api: vi.fn(), jsonPost: (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) }) }));
vi.mock('../../src/ModelViewer', () => ({ default: () => <div>模型预览</div> }));
const ready: Health = { cad:true, agh:true, modelConfigured:true, hasApiKey:true, usageEnabled:true, model:'test', version:'test' };
const postRequests: RequestInit[] = [];
let submit: (request: RequestInit) => Promise<unknown>;
let taskRecord: (id: string) => Promise<unknown>;
let currentHealth = ready;
beforeEach(() => {
  sessionStorage.clear(); postRequests.length = 0; currentHealth = ready;
  submit = async () => ({ id:'home-task', status:'running', events:[] });
  taskRecord = async id => ({ id, status:'running', events:[] });
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url === '/api/health') return currentHealth as never;
    if (url === '/api/catalog') return [] as never;
    if (url === '/assets/demo-cases/cases.json') return { cases:[] } as never;
    if (url === '/api/settings') return { providerId:'agnes-ai', model:'test', hasKey:currentHealth.hasApiKey, usageEnabled:currentHealth.usageEnabled } as never;
    if (url === '/api/tasks') { postRequests.push(options!); return await submit(options!) as never; }
    if (url.startsWith('/api/tasks?')) return { items:[], total:0 } as never;
    if (url.startsWith('/api/tasks/')) return await taskRecord(url.slice('/api/tasks/'.length)) as never;
    return {} as never;
  });
});

it('keeps a pending submission alive across navigation and receives its task id in the background', async () => {
  let accept!: (value: unknown) => void;
  submit = () => new Promise(resolve => { accept = resolve; });
  const user = userEvent.setup(); render(<App />);
  await user.selectOptions(screen.getByRole('combobox', { name:'任务类型' }), 'catalog_search');
  await user.type(screen.getByRole('textbox', { name:'这次需要完成什么？' }), '工作台中的定位支架检索');
  await user.click(screen.getByRole('button', { name:'开始任务' }));
  await user.click(screen.getByRole('button', { name:'工程资产库', exact:true }));
  expect(postRequests).toHaveLength(1);
  expect(postRequests[0].signal?.aborted).toBe(false);
  await act(async () => accept({ id:'accepted-away', status:'running', events:[] }));
  await waitFor(() => expect(JSON.parse(sessionStorage.getItem('engineeragent.workspace.v1.home')!).turns[0].task.id).toBe('accepted-away'));
  await user.click(screen.getByRole('button', { name:'任务工作台', exact:true }));
  expect(screen.getByRole('region', { name:'对话记录' })).toHaveTextContent('工作台中的定位支架检索');
  expect(screen.getByRole('region', { name:'本次任务记录' })).toHaveTextContent('正在执行');
  expect(postRequests).toHaveLength(1);
  expect(vi.mocked(api).mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
});

it('updates a running task while viewing another page and keeps the other workspace independent', async () => {
  const user = userEvent.setup(); render(<App />);
  await user.selectOptions(screen.getByRole('combobox', { name:'任务类型' }), 'catalog_search');
  await user.type(screen.getByRole('textbox', { name:'这次需要完成什么？' }), '首页独立任务');
  await user.click(screen.getByRole('button', { name:'开始任务' }));
  await screen.findByRole('region', { name:'本次任务记录' });
  await user.click(screen.getByRole('button', { name:'订单评审', exact:true }));
  expect(screen.getByRole('textbox', { name:'这次需要完成什么？' })).toHaveValue('');
  await user.type(screen.getByRole('textbox', { name:'这次需要完成什么？' }), '订单页另一个草稿');
  taskRecord = async id => ({ id, status:'completed', events:[], result:{ answer:'在后台完成的首页任务结果' } });
  await waitFor(() => expect(JSON.parse(sessionStorage.getItem('engineeragent.workspace.v1.home')!).turns[0].task.status).toBe('completed'), { timeout:3000 });
  expect(screen.queryByText('在后台完成的首页任务结果')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name:'任务工作台', exact:true }));
  expect(screen.getByText('在后台完成的首页任务结果')).toBeVisible();
  expect(screen.getByRole('region', { name:'对话记录' })).toHaveTextContent('首页独立任务');
  await user.click(screen.getByRole('button', { name:'订单评审', exact:true }));
  expect(screen.getByRole('textbox', { name:'这次需要完成什么？' })).toHaveValue('订单页另一个草稿');
  expect(postRequests).toHaveLength(1);
});

it('replaces the CAD debug page with part search and labels settings plainly', async () => {
  render(<App />);
  expect(screen.queryByRole('button', { name:'CAD 调试台', exact:true })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name:'零件检索', exact:true })).toBeVisible();
  expect(screen.queryByRole('button', { name:'设置', exact:true })).not.toBeInTheDocument();
  await userEvent.setup().click(await screen.findByRole('button', { name:/选择模型：test/ }));
  expect(screen.getByRole('dialog', { name:'模型设置' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name:'工程资产库' })).not.toBeInTheDocument();
});

it('shows a prominent missing-key notice on workspace and catalog, with a direct settings action', async () => {
  currentHealth = { ...ready, modelConfigured:false, hasApiKey:false, usageEnabled:false };
  const user = userEvent.setup(); render(<App />);
  const notice = await screen.findByRole('status', { name:'模型配置提醒' });
  expect(notice).toHaveTextContent('尚未配置 API Key');
  expect(screen.getByRole('button', { name:'开始任务' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name:'工程资产库', exact:true }));
  expect(screen.getByRole('status', { name:'模型配置提醒' })).toHaveTextContent('尚未配置 API Key');
  await user.click(within(screen.getByRole('status', { name:'模型配置提醒' })).getByRole('button', { name:'配置 API Key' }));
  expect(await screen.findByRole('textbox', { name:'模型名称' })).toBeVisible();
  expect(screen.getByRole('status', { name:'API Key 配置提醒' })).toHaveTextContent('此接口尚未保存 API Key');
});

it('distinguishes a disabled connection from a missing key and clears the notice when ready', () => {
  const view = render(<ModelSetupNotice health={{ ...ready, modelConfigured:false, usageEnabled:false }} onOpenSettings={() => {}} />);
  expect(screen.getByRole('status', { name:'模型配置提醒' })).toHaveTextContent('真实模型调用尚未启用');
  expect(screen.queryByText('尚未配置 API Key')).not.toBeInTheDocument();
  view.rerender(<ModelSetupNotice health={ready} onOpenSettings={() => {}} />);
  expect(screen.queryByRole('status', { name:'模型配置提醒' })).not.toBeInTheDocument();
  view.rerender(<ModelSetupNotice health={{ ...ready, modelConfigured:false, publicTrial:true }} onOpenSettings={() => {}} />);
  expect(screen.queryByRole('status', { name:'模型配置提醒' })).not.toBeInTheDocument();
});
