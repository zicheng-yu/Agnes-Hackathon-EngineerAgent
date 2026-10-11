const clip = (value, length = 1200) => typeof value === 'string' ? value.slice(0, length) : '';
const names = {industrial_get_document:'读取图纸',industrial_read_input:'读取输入证据',industrial_search_catalog:'检索历史零件',industrial_review_order:'评审采购与生产条件',industrial_geometry:'执行几何工具',industrial_request_clarification:'请求补充资料'};
const operationNames = {build:'生成模型',validate:'检查几何',project:'生成投影视图',patch:'局部修复',assembly:'构建装配',compare_views:'对照图纸与投影'};
const checkNames = {bbox:'外形',hole_count:'孔数',hole_pitch:'孔距',hole_pcd:'分度圆',hole_positions:'孔位',circular_edge_diameter:'圆边直径',solids:'实体数',valid:'实体有效',volume:'体积'};
const number = value => typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : Array.isArray(value) ? `${value.length} 个点` : value == null ? '无' : String(value);
function checkText(check) {
 const label = [check.diameter ? `Ø${number(check.diameter)}` : '', checkNames[check.kind] || check.kind, check.axis ? String(check.axis).toUpperCase() : ''].filter(Boolean).join(' ');
 return `${label} 图纸 ${number(check.expected)} / 实测 ${number(check.actual)} ${check.passed ? '✓' : '✗'}`;
}
function errorText(result) {
 const error = result?.manifest?.errors?.[0] || (typeof result?.error === 'object' ? result.error : null);
 return clip(error ? [error.code, error.message].filter(Boolean).join(' · ') : typeof result?.error === 'string' ? result.error : '', 600);
}
export function readableAGHEvent(event, calls = new Map()) {
 const data = event?.data || {};
 if(event?.type === 'tool/call') {
  calls.set(data.toolUseId, data.name);
  const args = data.args || {};
  const plan = args.input && typeof args.input === 'object' ? args.input : {};
  const input = data.name === 'industrial_geometry' ? [operationNames[args.operation] || args.operation || '几何处理', plan.name || plan.id, Array.isArray(plan.features) ? `${plan.features.length} 个特征` : '', Array.isArray(plan.checks) ? `${plan.checks.length} 项检查` : ''].filter(Boolean).join(' · ')
    : data.name === 'industrial_request_clarification' ? clip(args.question || '请求补充资料')
    : clip(args.query || args.text || args.documentId || args.path || '读取任务参数');
  return {type:'tool/call',phase:'running',toolUseId:data.toolUseId,toolName:data.name,message:names[data.name] || data.name || '调用工具',input};
 }
 if(event?.type === 'tool/result') {
  const name = calls.get(data.toolUseId) || '工具';
  const result = data.structured;
  const failed = Boolean(data.isError || result?.success === false);
  let output = failed ? `工具返回错误：${errorText(result) || '请查看反馈。'}` : '工具执行完成。';
  if(result?.manifest) {
    const verification = result.manifest.verification, checks = Array.isArray(verification?.checks) ? verification.checks : [];
    const head = result.manifest.status === 'failed' ? `运算失败：${errorText(result)}` : verification?.passed === true ? `几何检查通过（${checks.length}/${checks.length}）` : verification?.passed === false ? `检查未通过（${checks.filter(c => c.passed).length}/${checks.length}），需要修复` : '运算完成，已生成结果文件';
    output = clip([head, ...checks.slice(0, 12).map(checkText)].join('；'), 1500);
  }
  else if(result?.status === 'needs_input') output = clip(`需要补充：${(result.missing || []).map(entry => entry.evidence ? `${entry.item}（${entry.evidence}）` : entry.item).join('；')}`, 1500);
  else if(result?.summary && Array.isArray(result?.items)) output = `识别 ${result.items.length} 行，估算 ${result.summary.totalHours ?? '待确认'} 小时。`;
  else if(Array.isArray(result?.assets || result?.items)) { const items = result.assets || result.items; output = clip(`找到 ${result.totalMatches ?? items.length} 条${result.matchMode === 'ranked_partial' ? '（按相关度排序）' : ''}：${items.slice(0, 6).map(item => [item.displayCode, item.name].filter(Boolean).join(' ')).join('；')}`, 1500); }
  const checkFailed = result?.manifest?.verification?.passed === false;
  return {type:'tool/result',phase:failed||checkFailed?'failed':'completed',toolUseId:data.toolUseId,toolName:name,message:names[name] || name,output};
 }
 if(event?.type === 'assistant/message') {
  const text = (Array.isArray(data.content) ? data.content : []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
  return text ? {type:'assistant',message:clip(text,12000)} : null;
 }
 if(event?.type === 'turn/end') return {type:'turn/end',message:'AGH 任务轮次结束'};
 return null;
}
