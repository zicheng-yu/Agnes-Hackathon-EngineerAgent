/** Deterministic, local purchase-text tools. No LLM, network, or filesystem side effects. */
const EMPTY = /^(?:[-—/]+|未注明|未填写|待定|未知|不详|n\/?a|null)?$/i;
const clean = value => {
  const text = String(value ?? '').normalize('NFKC').trim();
  return EMPTY.test(text) ? null : text;
};
const key = value => (clean(value) || '').toLowerCase().replace(/[\s·_]/g, '');
const materialKey = value => {
  const text = (clean(value) || '').toUpperCase().replace(/\s/g, '');
  return ({'304不锈钢': 'SUS304', '不锈钢304': 'SUS304'})[text] || text;
};
const revisionKey = value => key(value).replace(/^(?:rev\.?|revision|版本)\s*/i, '');
const specKey = value => key(value).replace(/^按图(?:号)?[:：]?/, '');
const round = value => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const issue = (code, message, severity = 'blocker', evidence = undefined) => ({code, message, severity, ...(evidence ? {evidence} : {})});

const LABELS = {
  name: ['零件名称', '物料名称', '品名', '名称', '零件'],
  internalCode: ['内部编号', '零件编号', '物料编码', '内部料号', '料号', '编号'],
  quantity: ['采购数量', '数量', '订购量'],
  quantityUnit: ['计量单位', '单位'],
  requestedMaterial: ['材料牌号', '材质', '材料'],
  requestedRevision: ['图纸版本', '修订版', '版本', '版次'],
  deliveryText: ['交货日期', '交付日期', '交期', '交货期'],
  specification: ['规格图号', '规格', '图号', '图纸编号'],
};
const labelMap = new Map(Object.entries(LABELS).flatMap(([field, labels]) => labels.map(label => [label, field])));
const labelPattern = [...labelMap.keys()].sort((a, b) => b.length - a.length).join('|');
const noteLine = /^\s*(?:备注|说明|注\d*|附注|合同编号|采购单号|供应商|采购方|买方|卖方|签订日期|付款|合计|总计|联系人|地址|电话|示例说明|数据来源|声明)(?:\s*[:：|\t]|\s+)/;

function parseQuantity(value, explicitUnit) {
  const raw = clean(value);
  if (!raw) return {quantity: null, quantityUnit: clean(explicitUnit), quantityError: null};
  const match = raw.match(/^(\d+(?:,\d{3})*(?:\.\d+)?)\s*(件|个|套|只|台|pcs?|sets?)?$/i);
  if (!match) return {quantity: null, quantityUnit: clean(explicitUnit), quantityError: '数量必须为明确的正整数；未推测中文数词、范围或约数'};
  const number = Number(match[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000) return {quantity: null, quantityUnit: clean(explicitUnit), quantityError: '数量超出支持的正整数范围'};
  const suffix = clean(match[2]);
  const declaredUnit = clean(explicitUnit);
  const normalizeUnit = text => /^(?:pcs?|个|只|件)$/i.test(text || '') ? '件' : /^(?:sets?|套)$/i.test(text || '') ? '套' : text;
  if (suffix && declaredUnit && normalizeUnit(suffix) !== normalizeUnit(declaredUnit)) return {quantity: number, quantityUnit: declaredUnit, quantityError: '数量后缀与单位列冲突'};
  return {quantity: number, quantityUnit: normalizeUnit(declaredUnit || suffix), quantityError: null};
}

function parseDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cellsOf(line) {
  if (line.includes('|')) {
    const cells = line.split('|').map(x => x.trim());
    if (!cells[0]) cells.shift();
    if (!cells.at(-1)) cells.pop();
    return cells;
  }
  if (line.includes('\t')) return line.split('\t').map(x => x.trim());
  return line.trim().split(/\s{2,}/);
}

function readHeader(cells) {
  const header = cells.map(cell => {
    const normal = cell.normalize('NFKC');
    const unit = normal.match(/^数量\((件|个|套|只|台)\)$/)?.[1];
    return {field: labelMap.get(normal.replace(/\([^)]*\)$/, '').trim()), unit};
  });
  const fields = header.map(x => x.field);
  return fields.includes('quantity') && (fields.includes('name') || fields.includes('internalCode')) && fields.filter(Boolean).length >= 3 ? header : null;
}

function labelledFields(line) {
  // Match only explicit field boundaries. A remark containing an ID is never an order row.
  const content = line.split(/[;；,，|]\s*(?:备注|说明|附注)\s*[:：]/, 1)[0];
  const regex = new RegExp(`(?:^|[;；,，|\\t])\\s*(${labelPattern})\\s*[:：]`, 'g');
  const matches = [...content.matchAll(regex)];
  const fields = {};
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const field = labelMap.get(match[1]);
    const value = content.slice(start, matches[index + 1]?.index ?? content.length).trim();
    if (field in fields && key(fields[field]) !== key(value)) {
      (fields.__conflicts ||= []).push(field);
    } else fields[field] = value;
  }
  return fields;
}

/** Recognized rows retain exact source text and 1-based physical line numbers. */
export function parseOrder(text) {
  if (typeof text !== 'string') throw new TypeError('采购文本必须是字符串');
  if (text.length > 500_000) throw new RangeError('采购文本不能超过 500000 字符');
  const lines = [], unparsedLines = [], ignoredLines = [], warnings = [];
  let header = null;
  text.split(/\r?\n/).forEach((sourceText, index) => {
    const lineNumber = index + 1;
    if (!sourceText.trim()) return;
    if (noteLine.test(sourceText)) {
      ignoredLines.push({lineNumber, sourceText, reason: 'document_note_or_header'});
      return;
    }
    const cells = cellsOf(sourceText);
    const nextHeader = readHeader(cells);
    if (nextHeader) { header = nextHeader; return; }
    if (/^[\s|:\-—]+$/.test(sourceText)) return;
    let fields = labelledFields(sourceText);
    if (!('name' in fields || 'internalCode' in fields) && header && cells.length === header.length) {
      fields = {};
      header.forEach((column, i) => {
        if (column.field) fields[column.field] = cells[i];
        if (column.field === 'quantity' && column.unit) fields.quantityUnit = column.unit;
      });
    }
    if (!('name' in fields || 'internalCode' in fields) || !Object.keys(fields).some(x => ['quantity', 'requestedMaterial', 'requestedRevision', 'specification'].includes(x))) {
      unparsedLines.push({lineNumber, sourceText, reason: 'unrecognized_order_row'});
      return;
    }
    const quantity = parseQuantity(fields.quantity, fields.quantityUnit);
    const row = {
      lineId: `line-${lineNumber}`, lineNumber, sourceText,
      name: clean(fields.name), internalCode: clean(fields.internalCode),
      quantity: quantity.quantity, quantityUnit: quantity.quantityUnit,
      requestedMaterial: clean(fields.requestedMaterial), requestedRevision: clean(fields.requestedRevision),
      specification: clean(fields.specification), requestedDelivery: clean(fields.deliveryText),
      deliveryDate: parseDate(fields.deliveryText), parser: 'rule-based', issues: [],
    };
    if (quantity.quantityError) row.issues.push(issue('invalid_quantity', quantity.quantityError));
    if (fields.__conflicts?.length) row.issues.push(issue('conflicting_fields', `同一行字段重复且值不一致：${fields.__conflicts.join('、')}，未采用后值覆盖`));
    if (row.requestedDelivery && !row.deliveryDate) row.issues.push(issue('ambiguous_delivery_date', '交期未给出可解析的完整年月日；未自动补年份或推算相对日期'));
    lines.push(row);
  });
  if (unparsedLines.length) warnings.push({code: 'unparsed_lines', message: `${unparsedLines.length} 行未按采购明细识别，请核对原文`, lineNumbers: unparsedLines.map(x => x.lineNumber)});
  if (!lines.length) warnings.push({code: 'no_order_rows', message: '未识别采购明细；支持有列名的采购表和带字段标签的明细行'});
  return {parser: 'rule-based', schemaVersion: '1.0', lines, warnings, unparsedLines, ignoredLines};
}

const assetNames = asset => [asset.name, ...(asset.aliases || [])].map(key).filter(Boolean);
const assetCodes = asset => [asset.id, asset.sku, asset.internalCode, ...(asset.internalCodes || [])].map(key).filter(Boolean);
function similarity(a, b) {
  const first = key(a), second = key(b);
  if (!first || !second) return 0;
  if (first === second) return 1;
  const grams = value => new Set(value.length < 2 ? [value] : Array.from({length: value.length - 1}, (_, i) => value.slice(i, i + 2)));
  const aa = grams(first), bb = grams(second);
  return 2 * [...aa].filter(x => bb.has(x)).length / (aa.size + bb.size);
}

/** Matches identity separately from material/revision; names alone never establish equivalence. */
export function matchOrder(lines, catalog) {
  if (!Array.isArray(lines) || !Array.isArray(catalog)) throw new TypeError('lines 和 catalog 必须是数组');
  return lines.map(line => {
    const ranked = catalog.map(asset => {
      const codeExact = Boolean(line.internalCode && assetCodes(asset).includes(key(line.internalCode)));
      const nameExact = Boolean(line.name && assetNames(asset).includes(key(line.name)));
      const nameSimilarity = Math.max(0, ...assetNames(asset).map(name => similarity(line.name, name)));
      const score = codeExact ? 1 : nameExact ? 0.9 : round(nameSimilarity * 0.7);
      const reasons = codeExact ? ['内部编号或资产 ID 完全匹配'] : nameExact ? ['名称完全匹配；仍需核对内部编号、版本、材料和规格'] : ['名称字符相似，仅供候选检索'];
      const materialStatus = !line.requestedMaterial ? 'missing_request' : !asset.material ? 'unknown_source' : materialKey(line.requestedMaterial) === materialKey(asset.material) ? 'match' : 'conflict';
      return {id: asset.id, name: asset.name, score, reasons, codeExact, nameExact, materialStatus, sourceMaterial: asset.material || null};
    }).filter(x => x.score >= 0.3).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const codeMatches = ranked.filter(x => x.codeExact);
    const nameMatches = ranked.filter(x => x.nameExact);
    const selected = codeMatches.length === 1 ? codeMatches[0] : !line.internalCode && nameMatches.length === 1 ? nameMatches[0] : null;
    const issues = [...(line.issues || [])];
    if (codeMatches.length > 1 || (!line.internalCode && nameMatches.length > 1)) issues.push(issue('ambiguous_identity', '编号或名称对应多个资产，不能自动选择'));
    if (line.internalCode && !codeMatches.length) issues.push(issue('unknown_internal_code', '内部编号未在资产登记中找到；名称相似不能覆盖编号差异'));
    if (!line.internalCode) issues.push(issue('missing_internal_code', '缺少明确内部编号；名称命中仅为候选关系'));
    if (selected?.codeExact && line.name && !selected.nameExact) issues.push(issue('name_code_conflict', '编号与名称未同时匹配，请确认合同中的零件身份'));
    if (selected?.materialStatus === 'unknown_source') issues.push(issue('source_material_unknown', '资产文件未登记材料；演示企业材料只能作为单独的台账假设', 'info'));
    if (selected?.materialStatus === 'conflict') issues.push(issue('source_material_conflict', '请求材料与公开源模型材料不同，不能按同一设计直接评审'));
    return {...line, candidates: ranked.slice(0, 5), matchedAssetId: selected?.id || null,
      identityStatus: selected?.codeExact ? 'exact_code' : selected ? 'name_only' : ranked.length ? 'candidate_only' : 'unmatched',
      materialStatus: selected?.materialStatus || (line.requestedMaterial ? 'unresolved' : 'missing_request'),
      status: selected ? 'needs_review' : 'unmatched', issues};
  });
}

function blankProduction(reason) {
  return {availableStock: null, allocatedStock: null, toProduce: null, setupHours: null, unitHours: null, totalHours: null,
    route: [], machine: [], evidence: [], canEstimate: false, canCommit: false, commitment: 'not_a_real_production_commitment', blockedReason: reason};
}

/** Review uses explicit synthetic enterprise assumptions and conserves stock across all rows. */
export function reviewOrder({text, lines, catalog, enterprise} = {}) {
  if (!Array.isArray(catalog)) throw new TypeError('缺少资产 catalog');
  if (enterprise?.dataSource !== 'synthetic_demo') throw new TypeError('此演示工具要求企业台账显式声明 dataSource=synthetic_demo');
  const parsed = typeof text === 'string' ? parseOrder(text) : {parser: 'rule-based', lines, warnings: [], unparsedLines: []};
  if (!Array.isArray(parsed.lines)) throw new TypeError('请提供 text 或 lines');
  const masters = enterprise.partMasters || [];
  for (const [label, records] of [['partMasters', masters], ['inventoryLots', enterprise.inventoryLots || []], ['machines', enterprise.machines || []]]) {
    if (!Array.isArray(records)) throw new TypeError(`${label} 必须是数组`);
    const ids = records.map(record => clean(record.id));
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new TypeError(`${label} 中的 id 必须存在且唯一`);
  }
  const masterKeys = masters.map(master => `${key(master.internalCode)}|${revisionKey(master.revision)}`);
  if (new Set(masterKeys).size !== masterKeys.length) throw new TypeError('同一内部编号与版本只能登记一条企业规格');
  const enriched = catalog.map(asset => ({...asset,
    internalCodes: [...(asset.internalCodes || []), ...masters.filter(p => p.assetId === asset.id).map(p => p.internalCode)],
  }));
  const items = matchOrder(parsed.lines, enriched);
  const inventory = enterprise.inventoryLots || [];
  const remaining = new Map(inventory.map(lot => [lot.id, Math.max(0, Number(lot.onHand) - Number(lot.reserved))]));
  const machines = new Map((enterprise.machines || []).map(machine => [machine.id, machine]));
  const machineUsed = new Map();
  for (const item of items) {
    item.dataSource = 'synthetic_demo';
    item.production = blankProduction('身份、订单要求及台账尚未全部核对');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10_000_000) item.issues.push(issue('invalid_quantity', '采购数量必须是范围内的正整数'));
    for (const [field, code, label] of [['quantity', 'missing_quantity', '数量'], ['requestedMaterial', 'missing_material', '材料'], ['requestedRevision', 'missing_revision', '版本'], ['specification', 'missing_specification', '规格/图号'], ['deliveryDate', 'missing_delivery_date', '完整交期'], ['quantityUnit', 'missing_quantity_unit', '计量单位']]) {
      if (!item[field]) item.issues.push(issue(code, `缺少${label}，不能形成完整生产评审`));
    }
    if (!item.matchedAssetId) continue;
    const related = masters.filter(master => master.assetId === item.matchedAssetId && key(master.internalCode) === key(item.internalCode));
    let master = item.requestedRevision ? related.find(candidate => revisionKey(candidate.revision) === revisionKey(item.requestedRevision)) : undefined;
    if (!related.length) item.issues.push(issue('enterprise_spec_missing', '企业台账中没有该编号的受控规格'));
    else if (item.requestedRevision && !master) item.issues.push(issue('revision_conflict', `请求版本未登记；演示台账版本为 ${related.map(x => x.revision).join('、')}`));
    if (master) {
      if (!clean(master.material)) item.issues.push(issue('enterprise_material_unknown', '企业规格尚未登记材料，不能用公开模型或名称推测'));
      else if (item.requestedMaterial && materialKey(master.material) !== materialKey(item.requestedMaterial)) item.issues.push(issue('material_conflict', `请求材料与演示规格 ${master.material} 不一致`));
      if (!clean(master.specification)) item.issues.push(issue('enterprise_specification_unknown', '企业规格/图号未知'));
      else if (item.specification && specKey(master.specification) !== specKey(item.specification)) item.issues.push(issue('specification_conflict', `请求规格/图号与演示登记 ${master.specification} 不一致`));
      if (master.unit !== item.quantityUnit) item.issues.push(issue('unit_conflict', `订单单位与台账单位 ${master.unit} 不一致，未自动换算`));
      if (!Array.isArray(master.route) || !master.route.length) item.issues.push(issue('route_missing', '缺少演示工序路线'));
      for (const step of master.route || []) {
        const machine = machines.get(step.machineId);
        if (!machine) item.issues.push(issue('machine_missing', `找不到工序设备 ${step.machineId}`));
        if (![step.setupHours, step.unitHours].every(x => Number.isFinite(x) && x >= 0)) item.issues.push(issue('invalid_route_time', '工序准备/单件工时必须为非负数'));
        if (machine && (!Number.isFinite(machine.availableHours) || machine.availableHours < 0)) item.issues.push(issue('invalid_machine_capacity', '可用设备工时必须为非负数'));
        if (machine?.materials?.length && !machine.materials.some(x => materialKey(x) === materialKey(master.material))) item.issues.push(issue('machine_material_mismatch', `设备 ${machine.name} 未登记加工材料 ${master.material}`));
      }
    }
    const blockers = item.issues.filter(x => x.severity === 'blocker');
    if (blockers.length || !master) { item.status = 'blocked'; item.production.blockedReason = blockers.map(x => x.message).join('；'); continue; }
    const eligible = inventory.filter(lot => lot.assetId === item.matchedAssetId && revisionKey(lot.revision) === revisionKey(item.requestedRevision)
      && materialKey(lot.material) === materialKey(item.requestedMaterial) && specKey(lot.specification) === specKey(item.specification)
      && lot.qualityStatus === 'qualified' && lot.unit === item.quantityUnit);
    if (eligible.some(lot => !Number.isFinite(lot.onHand) || !Number.isFinite(lot.reserved) || lot.onHand < 0 || lot.reserved < 0 || lot.reserved > lot.onHand)) {
      item.issues.push(issue('invalid_inventory', '库存/预留数量无效，停止数量与工时估算')); item.status = 'blocked'; continue;
    }
    const availableStock = round(eligible.reduce((sum, lot) => sum + remaining.get(lot.id), 0));
    const allocatedStock = Math.min(availableStock, item.quantity);
    const toProduce = item.quantity - allocatedStock;
    let toAllocate = allocatedStock;
    const inventoryEvidence = [];
    for (const lot of eligible) {
      const before = remaining.get(lot.id), taken = Math.min(before, toAllocate);
      remaining.set(lot.id, before - taken); toAllocate -= taken;
      inventoryEvidence.push({lotId: lot.id, onHand: lot.onHand, reserved: lot.reserved, availableBeforeThisLine: before, allocated: taken,
        revision: lot.revision, material: lot.material, qualityStatus: lot.qualityStatus, sourceType: 'synthetic_demo'});
    }
    const route = master.route.map(step => {
      const machine = machines.get(step.machineId);
      const hours = toProduce ? round(step.setupHours + step.unitHours * toProduce) : 0;
      const usedBefore = machineUsed.get(machine.id) || 0;
      const remainingBefore = round(machine.availableHours - usedBefore);
      machineUsed.set(machine.id, round(usedBefore + hours));
      if (hours > remainingBefore) item.issues.push(issue('capacity_shortfall', `${machine.name} 的演示可用工时不足：需要 ${hours} h，可用 ${remainingBefore} h`, 'review'));
      if (hours && enterprise.capacityWindow?.end && item.deliveryDate < enterprise.capacityWindow.end) item.issues.push(issue('delivery_not_covered', '交期早于台账产能统计窗口结束日；窗口总工时不能证明该日可交付', 'review'));
      return {...step, machineName: machine.name, productionQuantity: toProduce, requiredHours: hours, availableHoursBeforeThisLine: remainingBefore, sourceType: 'synthetic_demo'};
    });
    const setupHours = toProduce ? round(route.reduce((sum, step) => sum + step.setupHours, 0)) : 0;
    const unitHours = round(route.reduce((sum, step) => sum + step.unitHours, 0));
    const totalHours = round(route.reduce((sum, step) => sum + step.requiredHours, 0));
    item.status = item.issues.some(x => x.severity === 'review') ? 'needs_review' : 'ready';
    item.production = {availableStock, allocatedStock, toProduce, setupHours, unitHours, totalHours, route,
      machine: [...new Set(route.map(x => x.machineName))], canEstimate: true, canCommit: false,
      commitment: 'synthetic_scenario_only', capacityWindow: enterprise.capacityWindow || null,
      inventoryEvidence, evidence: [
        {type: 'part_master', id: master.id, internalCode: master.internalCode, revision: master.revision, material: master.material, specification: master.specification, sourceType: 'synthetic_demo'},
        {type: 'formula', expression: 'availableStock = 同版本/材料/规格合格库存 - 预留 - 本订单前序行占用；toProduce = max(0, quantity - allocatedStock)；totalHours = Σ(准备工时 + 单件工时 × 待产量)', sourceType: 'deterministic_rule'},
        {type: 'assumptions', text: '工序、设备能力、库存及工时均为演示假设；未检查真实材料采购、装夹、尺寸公差或连续排程。', sourceType: 'synthetic_demo'},
      ]};
  }
  const statusCounts = Object.fromEntries(['ready', 'needs_review', 'blocked', 'unmatched'].map(status => [status, items.filter(x => x.status === status).length]));
  const estimated = items.filter(x => x.production.canEstimate);
  return {schemaVersion: '1.0', parser: 'rule-based', dataSource: 'synthetic_demo', datasetId: enterprise.datasetId,
    items, warnings: parsed.warnings, unparsedLines: parsed.unparsedLines || [],
    summary: {lineCount: items.length, ...statusCounts, estimatedLineCount: estimated.length,
      requestedQuantity: items.reduce((sum, item) => sum + (item.quantity || 0), 0),
      allocatedStock: estimated.reduce((sum, item) => sum + item.production.allocatedStock, 0),
      toProduce: estimated.reduce((sum, item) => sum + item.production.toProduce, 0),
      totalHours: round(estimated.reduce((sum, item) => sum + item.production.totalHours, 0)),
      totalsScope: 'only_estimable_lines; quantities are piece counts, not weight or batch equivalents',
      unparsedLineCount: (parsed.unparsedLines || []).length,
      completeEstimate: estimated.length === items.length && items.length > 0 && !(parsed.unparsedLines || []).length,
      canCommit: false, note: '基于合成台账的确定性情景估算，不构成真实生产或交期承诺。',
      machineLoad: [...machineUsed].map(([id, hours]) => ({id, name: machines.get(id).name, requiredHours: hours, availableHours: machines.get(id).availableHours, remainingHours: round(machines.get(id).availableHours - hours)}))},
  };
}
