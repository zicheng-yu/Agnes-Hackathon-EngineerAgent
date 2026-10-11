import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseOrder, matchOrder, reviewOrder} from '../../server/order-tools.mjs';
import {loadCatalog} from '../../server/catalog.mjs';
import {fileURLToPath} from 'node:url';

const read = async url => JSON.parse(await readFile(url, 'utf8'));
const catalog = await loadCatalog(fileURLToPath(new URL('../../', import.meta.url)));
const enterprise = await read(new URL('../../assets/demo-enterprise/enterprise.json', import.meta.url));
const examples = await read(new URL('../../assets/demo-enterprise/orders.json', import.meta.url));
const normal = examples.find(x => x.id === 'normal-multi-item');
const review = (text, override = {}) => reviewOrder({text, catalog, enterprise, ...override});
const rowText = (quantity = 20, extra = {}) => {
  const fields = {品名: '摆线减速器主环壳', 内部编号: 'CYR-001', 数量: `${quantity}件`, 材料: 'PETG', 版本: 'A', 规格: 'CYR-001-A', 交期: '2026-10-20', ...extra};
  return Object.entries(fields).map(([k, v]) => `${k}：${v}`).join('；');
};

test('unparsed purchase text prevents an apparently complete order estimate', () => {
  const source = examples[0].text + '\n另外购买：定制支架 100 件，按附件加工。';
  const result = review(source);
  assert.equal(result.summary.lineCount, 2);
  assert.equal(result.summary.totalHours, 10.68);
  assert.equal(result.summary.completeEstimate, false);
  assert.equal(result.summary.unparsedLineCount, 1);
  assert.equal(result.unparsedLines[0].sourceText, source.split('\n').at(-1));
});

test('default machining case uses original metal demonstration parts and CNC routes', () => {
  assert.equal(examples[0].id, 'machining-priority');
  const result = review(examples[0].text);
  assert.deepEqual(result.items.map(x => x.matchedAssetId), ['flange-hub', 'guide-rod']);
  assert.deepEqual(result.items.map(x => x.requestedMaterial), ['45钢', '40Cr']);
  assert.deepEqual(result.items.map(x => x.status), ['ready', 'ready']);
  assert.equal(result.summary.allocatedStock, 20);
  assert.equal(result.summary.toProduce, 30);
  assert.equal(result.summary.totalHours, 10.68);
  assert.ok(result.items[0].production.route.some(x => x.machineId === 'cnc-lathe-01'));
  assert.ok(result.items[0].production.route.some(x => x.machineId === 'cnc-drill-01'));
  assert.ok(result.items.every(x => !x.production.canCommit));
});

test('multi-item text preserves source lines and counts only qualified stock minus reservations', () => {
  const result = review(normal.text);
  assert.equal(result.parser, 'rule-based');
  assert.equal(result.dataSource, 'synthetic_demo');
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].lineNumber, 3);
  assert.equal(result.items[0].sourceText, normal.text.split('\n')[2]);
  assert.equal(result.items[0].production.availableStock, 12); // 16 - 4; quarantine is excluded.
  assert.equal(result.items[0].production.toProduce, 8);
  assert.equal(result.items[0].production.totalHours, 9.88);
  assert.equal(result.summary.totalHours, 13.02);
  assert.equal(result.summary.ready, 3);
  assert.equal(result.summary.canCommit, false);
});

test('a fake ID inside a remark does not create an order or displace the real identity', () => {
  const parsed = parseOrder(examples.find(x => x.id === 'notes-are-not-orders').text);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].internalCode, 'SGH-003');
  assert.equal(parsed.lines[0].quantity, 5);
  assert.ok(parsed.ignoredLines.some(x => x.sourceText.includes('FAKE-999')));
  assert.ok(!JSON.stringify(parsed.lines).includes('FAKE-999'));
  const inline = review(`${rowText(20)}；备注：旧单参考；内部编号：FAKE-999；数量：9999件`);
  assert.equal(inline.items[0].internalCode, 'CYR-001');
  assert.equal(inline.items[0].quantity, 20);
});

test('material, revision and specification conflicts stop estimates; an unknown code is not overridden by an exact name', () => {
  const result = review(examples.find(x => x.id === 'conflicts-and-missing-fields').text);
  assert.deepEqual(result.items.map(x => x.status), ['blocked', 'blocked', 'blocked', 'unmatched']);
  assert.ok(result.items[0].issues.some(x => x.code === 'material_conflict'));
  assert.ok(result.items[1].issues.some(x => x.code === 'revision_conflict'));
  assert.ok(result.items[2].issues.some(x => x.code === 'missing_specification'));
  assert.ok(!result.items[2].issues.some(x => x.code === 'specification_conflict'));
  assert.equal(result.items[3].matchedAssetId, null);
  assert.ok(result.items[3].candidates.some(x => x.id === 'poseidon-pump-base'));
  assert.ok(result.items.every(x => x.production.totalHours === null && !x.production.canCommit));
});

test('missing material/revision/specification stays missing instead of being silently filled from the ledger', () => {
  const result = review(rowText(10, {材料: '未注明', 版本: '未注明', 规格: '未注明'}));
  const item = result.items[0];
  assert.equal(item.requestedMaterial, null);
  assert.equal(item.requestedRevision, null);
  assert.equal(item.specification, null);
  assert.equal(item.status, 'blocked');
  assert.ok(!item.issues.some(x => ['material_conflict', 'revision_conflict', 'specification_conflict'].includes(x.code)));
  assert.equal(item.production.totalHours, null);
});

test('name-only matching remains a candidate relation; source material unknown differs from a conflict', () => {
  const row = parseOrder('品名：SSG48 多腔驱动壳体；数量：5件；材料：PA12；版本：B；规格：SGH-003-B；交期：2026-10-20').lines;
  const matched = matchOrder(row, catalog)[0];
  assert.equal(matched.identityStatus, 'name_only');
  assert.equal(matched.materialStatus, 'unknown_source');
  const result = reviewOrder({lines: row, catalog, enterprise});
  assert.equal(result.items[0].status, 'blocked');
  assert.equal(result.items[0].production.canEstimate, false);
});

test('quantity edits recompute pending quantity and time, and do not mutate the ledger', () => {
  const before = JSON.stringify(enterprise);
  const small = review(rowText(20)).items[0].production;
  const larger = review(rowText(25)).items[0].production;
  assert.equal(larger.toProduce - small.toProduce, 5);
  assert.ok(Math.abs((larger.totalHours - small.totalHours) - small.unitHours * 5) < 1e-9);
  assert.equal(JSON.stringify(enterprise), before);
  assert.deepEqual(review(rowText(20)).items[0].production, small);
});

test('two rows cannot spend the same available inventory twice', () => {
  const result = review(`${rowText(8)}\n${rowText(8)}`);
  assert.deepEqual(result.items.map(x => x.production.availableStock), [12, 4]);
  assert.deepEqual(result.items.map(x => x.production.allocatedStock), [8, 4]);
  assert.deepEqual(result.items.map(x => x.production.toProduce), [0, 4]);
  assert.equal(result.summary.allocatedStock, 12);
});

test('known capacity overrun is a review issue rather than a promised delivery', () => {
  const result = review(examples.find(x => x.id === 'quantity-and-capacity').text);
  assert.equal(result.summary.needs_review, 3);
  assert.ok(result.summary.machineLoad.some(x => x.remainingHours < 0));
  assert.ok(result.items.every(x => x.production.canEstimate && !x.production.canCommit));
});

test('direct structured input still rejects negative quantities and duplicate inventory IDs', () => {
  const lines = parseOrder(rowText()).lines;
  lines[0].quantity = -4;
  const result = reviewOrder({lines, catalog, enterprise});
  assert.equal(result.items[0].status, 'blocked');
  assert.equal(result.items[0].production.totalHours, null);
  const duplicate = structuredClone(enterprise);
  duplicate.inventoryLots.push({...duplicate.inventoryLots[0]});
  assert.throws(() => review(rowText(), {enterprise: duplicate}), /id 必须存在且唯一/);
});

test('invalid calendar dates and unit conflicts are explicit', () => {
  const badDate = review(rowText(5, {交期: '2026-02-30'})).items[0];
  assert.equal(badDate.deliveryDate, null);
  assert.equal(badDate.status, 'blocked');
  const unitConflict = review(rowText(5, {数量: '5套', 单位: '件'})).items[0];
  assert.ok(unitConflict.issues.some(x => x.code === 'invalid_quantity'));
  assert.equal(unitConflict.production.totalHours, null);
  const duplicate = review(`${rowText(5)}；数量：500件`).items[0];
  assert.ok(duplicate.issues.some(x => x.code === 'conflicting_fields'));
  assert.equal(duplicate.production.canEstimate, false);
});
