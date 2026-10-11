import { useId } from "react";
import "./production-evidence.css";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null;
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.flatMap((item) => record(item) ? [record(item)!] : []) : [];
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const signedNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const format = (value: number): string => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(value);
const quantity = (value: number | null) => value === null ? "待补齐" : `${format(value)} 件`;
const hours = (value: unknown) => number(value) === null ? "待补齐" : `${format(number(value)!)} 小时`;
const humanText = (value: string) => value.replace(/内部编号|内部料号|\bSKU\b/g, "零件标识");

function completeSum(items: RecordValue[], field: string): number | null {
  if (!items.length || items.some((item) => number(item[field]) === null)) return null;
  return items.reduce((sum, item) => sum + number(item[field])!, 0);
}

/** Readable evidence only: this component does not fill gaps, calculate a new plan, or call services. */
export default function ProductionEvidence({ production }: { production: unknown }) {
  const headingId = useId();
  const data = record(production);
  const lots = records(data?.inventoryEvidence);
  const route = records(data?.route);
  const evidence = records(data?.evidence);
  const specifications = evidence.filter((item) => item.type === "part_master");
  const assumptions = evidence.filter((item) => item.type === "assumptions").map((item) => text(item.text)).filter((item): item is string => item !== null);
  const synthetic = data?.dataSource === "synthetic_demo" || data?.sourceType === "synthetic_demo"
    || data?.commitment === "synthetic_scenario_only"
    || [...lots, ...route, ...evidence].some((item) => item.sourceType === "synthetic_demo");
  const onHand = completeSum(lots, "onHand");
  const reserved = completeSum(lots, "reserved");
  const available = number(data?.availableStock);
  const allocated = number(data?.allocatedStock);
  const pending = number(data?.toProduce);
  const setup = number(data?.setupHours);
  const unit = number(data?.unitHours);
  const total = number(data?.totalHours);
  const window = record(data?.capacityWindow);
  const start = text(window?.start);
  const end = text(window?.end);
  const previousAllocation = onHand !== null && reserved !== null && available !== null && onHand - reserved >= available
    ? Math.round((onHand - reserved - available) * 1e6) / 1e6 : null;
  const formulaTotal = setup !== null && unit !== null && pending !== null ? setup + unit * pending : null;
  const formulaConflict = formulaTotal !== null && total !== null && Math.abs(formulaTotal - total) > 1e-5;
  const missing: string[] = [];
  const checks: string[] = [];
  for (const [label, value] of [["可用库存", available], ["本行分配数量", allocated], ["待产数量", pending], ["准备工时", setup], ["单件工时", unit], ["汇总工时", total]] as const) {
    if (value === null) missing.push(`${label}尚未提供。`);
  }
  if (onHand === null || reserved === null) missing.push("库存或预留记录不完整。");
  if (!specifications.length) missing.push("缺少材料、版本与规格的台账引用。");
  if (!route.length && pending !== 0) missing.push("工序与设备计划尚未提供。");
  route.forEach((step, index) => {
    if (!text(step.operation) || !text(step.machineName)) missing.push(`第 ${index + 1} 道工序的名称或设备尚未确认。`);
    if ([step.setupHours, step.unitHours, step.requiredHours].some((value) => number(value) === null)) missing.push(`第 ${index + 1} 道工序的工时不完整，不能据此确认整条路线总工时。`);
    const availableHours = signedNumber(step.availableHoursBeforeThisLine);
    const requiredHours = number(step.requiredHours);
    if (availableHours === null) missing.push(`第 ${index + 1} 道工序缺少可用设备工时，产能是否充足仍待确认。`);
    else if (requiredHours !== null && requiredHours > availableHours) checks.push(`${text(step.machineName) || `第 ${index + 1} 道工序的设备`}需要 ${format(requiredHours)} 小时，窗口内剩余 ${format(availableHours)} 小时，需调整资源或交期。`);
  });
  if (!start || !end) missing.push("未提供完整的产能统计区间，无法判断交期覆盖情况。");
  if (formulaConflict) checks.push("汇总工时与准备工时、单件工时的计算不一致，需要复核。");
  if (lots.some((lot) => lot.qualityStatus !== "qualified")) checks.push("部分库存批次的合格状态未确认，不能直接视为可投入生产的库存。");
  const partial = data?.canEstimate !== true || missing.length > 0 || formulaConflict;
  const blockedReason = text(data?.blockedReason);

  return <section className="production-evidence" aria-labelledby={headingId}>
    <header className="production-evidence__header"><div><h3 id={headingId}>生产计算依据</h3><p>查看库存分配、工序工时和引用资料。</p></div>
      <span className={`production-evidence__badge ${synthetic ? "" : "production-evidence__badge--unknown"}`}>{synthetic ? "合成演示数据" : "数据来源待确认"}</span>
    </header>
    <p className="production-evidence__source-note">{synthetic
      ? "基于演示台账计算。"
      : "数据来源尚未确认。"}</p>
    {!data ? <p className="production-evidence__notice" role="status">尚无生产依据。请先补充采购要求、库存和工序资料。</p> : <>
      {partial ? <div className="production-evidence__notice" role="status"><strong>估算依据待补齐</strong><p>{blockedReason ? humanText(blockedReason) : "当前只能展示已经提供的数据，不能将其视为完整订单估算。"}</p></div> : null}

      <dl className="production-evidence__metrics" aria-label="库存与生产数量">
        <div><dt>台账库存</dt><dd>{quantity(onHand)}</dd></div><div><dt>已预留</dt><dd>{quantity(reserved)}</dd></div>
        <div><dt>本行可用</dt><dd>{quantity(available)}</dd></div><div><dt>本行分配</dt><dd>{quantity(allocated)}</dd></div>
        <div><dt>待生产</dt><dd>{quantity(pending)}</dd></div><div><dt>{partial ? "已提供的工时小计" : "估算总工时"}</dt><dd>{hours(total)}</dd></div>
      </dl>
      <section className="production-evidence__section" aria-label="工序与工时">
        <h4>工序与工时</h4>
        {route.length ? <><div className="production-evidence__table-scroll"><table className="production-evidence__table">
          <caption>{partial ? "部分工序依据，缺失项仍待补齐" : "本行采购需求对应的工序"}</caption>
          <thead><tr><th scope="col">工序</th><th scope="col">设备</th><th scope="col">准备工时</th><th scope="col">单件工时</th><th scope="col">本次工时</th></tr></thead>
          <tbody>{route.map((step, index) => <tr key={index}><td>{text(step.operation) || "工序待确认"}</td><td>{text(step.machineName) || "设备待确认"}</td>
            <td>{hours(step.setupHours)}</td><td>{hours(step.unitHours)}</td><td>{hours(step.requiredHours)}</td></tr>)}</tbody>
        </table></div>{pending === 0 ? <p className="production-evidence__subnote">本行没有待产量，工序仅供后续生产参考，本次不应计入准备或加工工时。</p> : null}</>
          : <p className="production-evidence__empty">{pending === 0 ? "本行没有待产量，当前未附参考工序。" : "未提供可读取的工序记录。"}</p>}
      </section>

      <section className="production-evidence__section" aria-label="计算说明"><h4>计算说明</h4>
        <div className="production-evidence__formula"><span>可用库存 = 台账库存 − 已预留 − 本订单前序行已分配</span>
          <strong>{onHand !== null && reserved !== null && available !== null && previousAllocation !== null
            ? `${format(onHand)} − ${format(reserved)} − ${format(previousAllocation)} = ${format(available)} 件`
            : "库存依据不完整，暂不能核对扣减过程。"}</strong></div>
        <div className="production-evidence__formula"><span>本次工时 = 准备工时 + 单件工时 × 待产数量</span>
          <strong>{formulaTotal !== null && total !== null ? `${format(setup!)} + ${format(unit!)} × ${format(pending!)} = ${format(Math.round(formulaTotal * 1e6) / 1e6)} 小时` : "工时或待产数量不完整，暂不能核对汇总工时。"}</strong>
          {formulaConflict ? <p>所提供的汇总为 {hours(total)}，与上述计算不一致。</p> : null}</div>
        {start && end ? <p className="production-evidence__subnote">设备工时统计区间：{start} 至 {end}</p> : null}
      </section>

      <section className="production-evidence__section" aria-label="引用台账"><h4>引用台账</h4>
        <ul className="production-evidence__references">
          {specifications.map((item, index) => <li key={`spec-${index}`}><strong>零件规格记录</strong><p>材料：{text(item.material) || "未提供"}；版本：{text(item.revision) || "未提供"}。{text(item.specification) ? "规格已登记。" : "规格要求尚未提供。"}</p></li>)}
          {lots.map((lot, index) => <li key={`lot-${index}`}><strong>库存批次记录</strong><p>材料：{text(lot.material) || "未提供"}；版本：{text(lot.revision) || "未提供"}；质检：{lot.qualityStatus === "qualified" ? "记录为合格" : lot.qualityStatus === "quarantine" ? "待检，不能直接使用" : "尚未确认"}。</p>
            <p>库存 {quantity(number(lot.onHand))}，预留 {quantity(number(lot.reserved))}，本行分配 {quantity(number(lot.allocated))}。</p></li>)}
        </ul>
        {!lots.length && !specifications.length ? <p className="production-evidence__empty">未附库存批次或零件规格台账，不能验证数值来源。</p> : null}
      </section>
      {checks.length || missing.length ? <section className="production-evidence__section production-evidence__checks" aria-label="需要确认的事项"><h4>需要确认的事项</h4>
        <ul>{[...checks, ...missing].map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null}
      {partial && assumptions.length ? <section className="production-evidence__section production-evidence__assumptions" aria-label="估算范围"><h4>估算范围</h4>{assumptions.map((item, index) => <p key={index}>{humanText(item)}</p>)}</section> : null}
    </>}
  </section>;
}
