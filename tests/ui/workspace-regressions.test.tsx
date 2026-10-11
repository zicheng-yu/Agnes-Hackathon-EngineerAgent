import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '../../src/App';
import TaskWorkspace from '../../src/TaskWorkspace';
import { api } from '../../src/api';

vi.mock('../../src/api', () => ({ api: vi.fn(), jsonPost: (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) }) }));
vi.mock('../../src/Viewer', () => ({ default: () => <div>模型预览</div> }));
const health = { cad: true, agh: true, modelConfigured: false, model: 'test', version: 'test' };
const review = { summary: { completeEstimate: false }, items: [{ lineId: 'line-1', name: '法兰', quantity: 30, status: 'ready', production: { toProduce: 18, totalHours: 10.68 } }], unparsedLines: [{ lineNumber: 5, sourceText: '另外购买：定制支架 100 件' }], warnings: [{ code: 'unparsed_lines', message: '1 行未识别' }] };
beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api).mockImplementation(async (url: string) => {
    if (url === '/api/health') return health as never;
    if (url === '/api/catalog') return [] as never;
    if (url === '/assets/demo-cases/cases.json') return { cases: [] } as never;
    if (url === '/api/documents') return { id: 'draft-doc', name: 'drawing.pdf', pages: [{ page: 1, text: '' }] } as never;
    if (url === '/api/orders/review') return review as never;
    return {} as never;
  });
});

it('preserves a draft, attachment and pages through sidebar navigation and remount', async () => {
  const user = userEvent.setup();
  const first = render(<App />);
  await user.type(screen.getByRole('textbox', { name: '这次需要完成什么？' }), '请核对厚度和孔距');
  fireEvent.change(first.container.querySelector('input[type="file"]')!, { target: { files: [new File(['pdf'], 'drawing.pdf', { type: 'application/pdf' })] } });
  await screen.findByText('drawing.pdf');
  await user.clear(screen.getByRole('textbox', { name: '图纸页码' }));
  await user.type(screen.getByRole('textbox', { name: '图纸页码' }), '2, 3');
  await user.click(screen.getByRole('button', { name: '订单评审', exact: true }));
  await user.click(screen.getByRole('button', { name: '任务工作台', exact: true }));
  expect(screen.getByRole('textbox', { name: '这次需要完成什么？' })).toHaveValue('请核对厚度和孔距');
  expect(screen.getByRole('textbox', { name: '图纸页码' })).toHaveValue('2, 3');
  expect(screen.getByText('drawing.pdf')).toBeVisible();
  first.unmount(); render(<App />);
  expect(screen.getByRole('textbox', { name: '这次需要完成什么？' })).toHaveValue('请核对厚度和孔距');
  expect(screen.getByText('drawing.pdf')).toBeVisible();
});

it('restores a submitted task by id and fetches its current result', async () => {
  sessionStorage.setItem('engineeragent.workspace.v1.orders', JSON.stringify({ mode: 'order_review', instruction: '原订单', pages: '1', task: { id: 'saved-task', status: 'running' }, snapshot: { mode: 'order_review', instruction: '原订单', pages: [] } }));
  vi.mocked(api).mockImplementation(async (url: string) => url === '/api/tasks/saved-task' ? { id: 'saved-task', status: 'completed', result: { answer: '服务端最新评审结果' }, events: [] } as never : { cases: [] } as never);
  render(<TaskWorkspace storageKey="orders" initialMode="order_review" health={health} assets={[]} onSelectAsset={() => {}} onOpenSettings={() => {}} />);
  await waitFor(() => expect(screen.getByText('服务端最新评审结果')).toBeVisible());
  expect(screen.getByRole('textbox', { name: '这次需要完成什么？' })).toHaveValue('原订单');
});
