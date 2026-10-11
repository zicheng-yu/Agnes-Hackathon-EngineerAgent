import { useId, type ReactNode } from "react";
import "./inspection-report.css";

export type InspectionReportProps = { manifest: unknown; compact?: boolean };
type Data = Record<string, unknown>;
type Decision = "pass" | "fail" | "unknown";
type Check = { value: Data; owner?: string; key: string };
const MISSING = "未提供";
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const rows = (value: unknown): Data[] =>
  Array.isArray(value)
    ? value.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const flag = (value: unknown): Decision =>
  value === true ? "pass" : value === false ? "fail" : "unknown";
const ratio = (value: unknown) => {
  const n = number(value);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
};
const format = (value: unknown): string => {
  const n = number(value);
  return n === undefined
    ? MISSING
    : new Intl.NumberFormat(
        "zh-CN",
        n !== 0 && Math.abs(n) < 0.001
          ? { maximumSignificantDigits: 3 }
          : { maximumFractionDigits: 3 },
      ).format(Object.is(n, -0) ? 0 : n);
};
const quantity = (value: unknown, unit = "") =>
  number(value) === undefined ? MISSING : `${format(value)}${unit ? ` ${unit}` : ""}`;
const percentage = (value: unknown) =>
  ratio(value) === undefined
    ? MISSING
    : `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(ratio(value)! * 100)}%`;
const operationNames: Record<string, string> = {
  build: "模型生成",
  patch: "模型修复",
  validate: "几何校验",
  project: "投影视图",
  assembly: "装配检查",
  import: "模型导入",
  compare_views: "视图对照",
};
const errors: Record<string, string> = {
  INVALID_TOPOLOGY: "生成的实体结构无效，需要调整相关特征。",
  EMPTY_SHAPE: "当前特征没有生成有效几何。",
  KERNEL_ERROR: "几何构造失败，请检查相关特征的尺寸和连接关系。",
  UNKNOWN_FEATURE: "建模特征引用缺失。",
  UNKNOWN_PART: "装配中引用的零件未提供。",
  INVALID_INPUT: "输入资料的格式或必填项不完整。",
  INVALID_PLAN: "未提供完整的建模步骤。",
  UNSUPPORTED_UNITS: "当前工具只接受毫米单位。",
  RESOURCE_LIMIT: "输入超过工具支持的规模。",
  INVALID_CHECK: "检查条件不完整或不受支持。",
};

function Status({
  decision,
  labels = ["已通过", "未通过", "未提供"],
}: {
  decision: Decision;
  labels?: [string, string, string];
}) {
  return (
    <span className={`inspection-report__status inspection-report__status--${decision}`}>
      {labels[decision === "pass" ? 0 : decision === "fail" ? 1 : 2]}
    </span>
  );
}
function Metric({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="inspection-report__metric">
      <dt>{label}</dt>
      <dd>{children}</dd>
      {note && <span className="inspection-report__note">{note}</span>}
    </div>
  );
}
function Section({
  title,
  children,
  compact = false,
  count,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
  count?: number;
}) {
  return (
    <details className="inspection-report__section" open={!compact}>
      <summary>
        {title}
        {count !== undefined && <span>{count} 项</span>}
      </summary>
      <div className="inspection-report__section-body">{children}</div>
    </details>
  );
}
function checkName(check: Data) {
  const names: Record<string, string> = {
    bbox: "外形尺寸",
    volume: "实体体积",
    solids: "实体数量",
    valid: "几何有效性",
    circular_edge_diameter: "圆边直径",
  };
  const name = text(check.name) || names[text(check.kind) || ""] || "几何检查项";
  return check.kind === "bbox" && ["x", "y", "z"].includes(String(check.axis))
    ? `${String(check.axis).toUpperCase()} 向尺寸`
    : name;
}
function checkUnit(check: Data) {
  return check.kind === "volume"
    ? "cm³"
    : ["bbox", "circular_edge_diameter", "instance_z"].includes(String(check.kind))
      ? "mm"
      : check.kind === "solids"
        ? "个"
        : "";
}
function checkValue(value: unknown, check: Data) {
  if (check.kind === "valid" && (value === 1 || value === true)) return "有效";
  if (check.kind === "valid" && (value === 0 || value === false)) return "无效";
  const n = number(value);
  return n === undefined
    ? MISSING
    : quantity(check.kind === "volume" ? n / 1000 : n, checkUnit(check));
}
/** Assembly placement checks report one measured height per pattern copy; show the copy farthest from the target. */
function placementCheck(check: Data): Data {
  if (check.kind !== "instance_z") return check;
  const expected = number(check.expected);
  const measured = Object.values(record(check.actual)).map(number).filter((n): n is number => n !== undefined);
  const worst = expected === undefined ? measured[0] : measured.reduce<number | undefined>((far, n) => far === undefined || Math.abs(n - expected) > Math.abs(far - expected) ? n : far, undefined);
  return { ...check, actual: worst, name: `${text(check.instance) || "实例"} 底面高度` };
}
function checkDecision(check: Data): Decision {
  if (check.passed === false) return "fail";
  const actual = number(check.actual),
    expected = number(check.expected),
    tolerance = number(check.tolerance);
  if (
    actual !== undefined &&
    expected !== undefined &&
    tolerance !== undefined &&
    Math.abs(actual - expected) > tolerance
  )
    return "fail";
  if (actual === undefined || expected === undefined) return "unknown";
  return flag(check.passed);
}
function checkDeviation(check: Data) {
  const error = number(check.error);
  return error === undefined
    ? MISSING
    : quantity(check.kind === "volume" ? error / 1000 : error, checkUnit(check));
}
function materialName(value: unknown) {
  const source = text(value);
  if (!source || source === "unspecified") return MISSING;
  const names: Record<string, string> = {
    "45 steel": "45 钢",
    "Stainless steel": "不锈钢",
    "NBR (illustrative)": "丁腈橡胶（演示）",
    "Grade 8.8 steel (demo)": "8.8 级钢（演示）",
  };
  return names[source] || source;
}
function reasonText(value: unknown) {
  const reason = text(value);
  if (!reason) return MISSING;
  if (/No assembly constraints or disassembly path/i.test(reason))
    return "未提供装配约束和拆解路径，当前展开仅为位置示意。";
  return reason;
}

export function InspectionReport({ manifest: input, compact = false }: InspectionReportProps) {
  const titleId = useId();
  const outer = record(input);
  const manifest = Object.keys(record(outer.manifest)).length ? record(outer.manifest) : outer;
  const verification = record(manifest.verification);
  const measurements = Object.keys(record(manifest.measurements)).length
    ? record(manifest.measurements)
    : record(verification.measurements);
  const operation = text(manifest.operation) || "";
  const compare = operation === "compare_views";
  const parts = rows(manifest.parts),
    instances = rows(manifest.instances),
    bom = rows(manifest.bom);
  const checks: Check[] = [
    ...rows(verification.checks).map((value, index) => ({ value, key: `main-${index}` })),
    ...rows(verification.assembly_checks).map((value, index) => ({ value: placementCheck(value), owner: "装配位置", key: `assembly-${index}` })),
    ...parts.flatMap((part, partIndex) =>
      rows(record(part.verification).checks).map((value, index) => ({
        value,
        owner: text(part.name) || text(part.id),
        key: `part-${partIndex}-${index}`,
      })),
    ),
  ];
  const failedChecks = checks.filter(({ value }) => checkDecision(value) === "fail");
  const path = record(manifest.path_check),
    steps = rows(path.steps),
    initialInterferences = rows(path.initial_interferences);
  const moving = instances.filter(
    (item) =>
      Array.isArray(item.explode) &&
      item.explode.length === 3 &&
      item.explode.every((n) => number(n) !== undefined) &&
      item.explode.some((n) => n !== 0),
  );
  const fixed = instances.filter(
    (item) =>
      Array.isArray(item.explode) &&
      item.explode.length === 3 &&
      item.explode.every((n) => n === 0),
  );
  const uncheckedMoving = moving.filter(
    (item) => !steps.some((step) => step.instance_id === item.id && step.checked === true),
  );
  const missingMoving = uncheckedMoving.filter(
    (item) => !steps.some((step) => step.instance_id === item.id),
  );
  const failedPaths = steps.filter(
    (step) =>
      step.checked === true && (step.passed === false || rows(step.collisions).length > 0),
  );
  const checkedSteps = steps.filter((step) => step.checked === true);
  const pathConflict =
    typeof path.passed === "boolean" &&
    typeof verification.path_check_passed === "boolean" &&
    path.passed !== verification.path_check_passed;
  const pathDecision: Decision =
    failedPaths.length || initialInterferences.length || pathConflict
      ? "fail"
      : path.checked === false ||
          uncheckedMoving.length ||
          !checkedSteps.length ||
          checkedSteps.some((step) => flag(step.passed) === "unknown")
        ? "unknown"
        : flag(path.passed);
  const nameMap = new Map(
    parts.map((part) => [text(part.id), text(part.name) || text(part.id)]),
  );
  for (const part of bom)
    nameMap.set(text(part.part_id), text(part.name) || text(part.part_id));
  const instanceName = (id: unknown) => {
    const instance = instances.find((item) => item.id === id);
    const name = nameMap.get(text(instance?.part_id));
    return name ? `${name}（${text(id) || MISSING}）` : text(id) || MISSING;
  };
  const metrics = record(manifest.metrics),
    registration = record(manifest.registration);
  const precision = ratio(metrics.precision),
    recall = ratio(metrics.recall),
    threshold = ratio(verification.minimum_match_fraction);
  const compareBelowThreshold =
    compare &&
    threshold !== undefined &&
    ((precision !== undefined && precision < threshold) ||
      (recall !== undefined && recall < threshold));
  const errorRows = rows(manifest.errors);
  const failures: string[] = [];
  for (const error of errorRows)
    failures.push(
      `${text(error.feature_id) ? `特征 ${text(error.feature_id)}：` : ""}${errors[text(error.code) || ""] || text(error.message) || "工具报告了错误，具体原因未提供。"}`,
    );
  if (manifest.status === "failed" && !errorRows.length)
    failures.push(text(manifest.error) || "本次运算未完成，失败原因未提供。");
  if (measurements.valid === false) failures.push("几何结构检查未通过，当前实体需要修复。");
  for (const check of failedChecks)
    failures.push(
      `${check.owner ? `${check.owner} · ` : ""}${checkName(check.value)}：目标 ${checkValue(check.value.expected, check.value)}，实测 ${checkValue(check.value.actual, check.value)}，偏差 ${checkDeviation(check.value)}（允许 ${checkValue(check.value.tolerance, { ...check.value, kind: check.value.kind === "valid" ? "" : check.value.kind })}）。`,
    );
  for (const item of initialInterferences)
    failures.push(
      `初始位置存在干涉：${instanceName(item.a)} 与 ${instanceName(item.b)}，交叠体积 ${quantity(item.volume_mm3, "mm³")}。`,
    );
  for (const step of failedPaths)
    failures.push(
      `${instanceName(step.instance_id)} 的移动路径未通过${rows(step.collisions).length ? `，记录 ${rows(step.collisions).length} 处采样碰撞` : "，具体碰撞记录未提供"}。`,
    );
  if (pathConflict) failures.push("路径总判定与装配检查记录不一致，需要复核原始报告。");
  if (
    pathDecision === "fail" &&
    !failedPaths.length &&
    !initialInterferences.length &&
    !pathConflict
  )
    failures.push("路径检查未通过，具体失败步骤未提供。");
  if (verification.part_checks_passed === false && !failedChecks.length)
    failures.push("部件几何检查未通过，逐项检查记录未提供。");
  if (compareBelowThreshold)
    failures.push(
      `边缘匹配未达到 ${percentage(threshold)} 的要求：投影吻合 ${percentage(precision)}，原图覆盖 ${percentage(recall)}。`,
    );
  if (verification.passed === false && !failures.length)
    failures.push("报告记录检查未通过，但具体失败项未提供。");
  const hasUnknownEvidence =
    checks.some(({ value }) => checkDecision(value) === "unknown") ||
    (compare &&
      (precision === undefined || recall === undefined || threshold === undefined)) ||
    (!compare && flag(measurements.valid) === "unknown") ||
    (operation === "assembly" && pathDecision === "unknown" && moving.length > 0);
  const overall: Decision = failures.length
    ? "fail"
    : hasUnknownEvidence && verification.passed === true
      ? "unknown"
      : flag(verification.passed);
  const bbox = record(measurements.bbox);
  const dimensions =
    Array.isArray(bbox.size) &&
    bbox.size.length === 3 &&
    bbox.size.every((n) => number(n) !== undefined)
      ? `${bbox.size.map(format).join(" × ")} mm`
      : MISSING;
  const volume = number(measurements.volume_mm3);
  const knownGeometry = measurements.valid === true || measurements.valid === false;
  const showPaths = operation === "assembly" || Object.keys(path).length > 0;
  const noMovement =
    operation === "assembly" && path.checked !== false && instances.length > 0 && fixed.length === instances.length && steps.length === 0;
  const unknownInputs = !Object.keys(manifest).length;

  return (
    <section
      className={`inspection-report${compact ? " inspection-report--compact" : ""}`}
      aria-labelledby={titleId}
    >
      <header className="inspection-report__header">
        <div>
          <h3 id={titleId}>{operationNames[operation] || "检查"}报告</h3>
          {text(manifest.name) && <p>{text(manifest.name)}</p>}
        </div>
        <Status decision={overall} labels={["检查已通过", "有待处理项", "总判定未提供"]} />
      </header>
      {overall !== "pass" && (
        <div className={`inspection-report__summary inspection-report__summary--${overall}`}>
          {failures.length ? (
            <>
              <strong>{failures.length} 项需要处理</strong>
              <ul>
                {failures.slice(0, compact ? 3 : 6).map((failure, i) => (
                  <li key={i}>{failure}</li>
                ))}
              </ul>
              {failures.length > (compact ? 3 : 6) && (
                <p>其余 {failures.length - (compact ? 3 : 6)} 项见下方明细。</p>
              )}
            </>
          ) : (
            <p>
              {unknownInputs
                ? "检查报告未提供。"
                : "校验结论未提供，可先查看已有测量与检查记录。"}
            </p>
          )}
          {manifest.status === "completed" && (
            <p className="inspection-report__note">运算已完成；校验结论见具体检查项。</p>
          )}
        </div>
      )}

      {!compare && (
        <>
          <dl className="inspection-report__metrics">
            <Metric label="几何有效性">
              <Status
                decision={flag(measurements.valid)}
                labels={["有效", "无效", "未提供"]}
              />
            </Metric>
            <Metric
              label="实体数量"
              note={
                !knownGeometry && number(measurements.mesh_components) !== undefined
                  ? `另有 ${format(measurements.mesh_components)} 个网格连通单元，不等同于已验证零件。`
                  : undefined
              }
            >
              {quantity(measurements.solids, "个")}
            </Metric>
            <Metric label="外形尺寸（X × Y × Z）">{dimensions}</Metric>
            <Metric label="体积">
              {volume === undefined ? MISSING : quantity(volume / 1000, "cm³")}
            </Metric>
          </dl>
          {operation === "import" && (
            <p className="inspection-report__note">
              已有模型的导入检查不代表从图纸重建成功。
              {!knownGeometry
                ? "当前没有实体有效性结论；网格单元不等同于可拆卸零件。"
                : "几何有效性不等于尺寸、工艺或装配关系已确认。"}
            </p>
          )}
          <Section
            title="几何检查明细"
            compact={compact && !failedChecks.length}
            count={checks.length}
          >
            {checks.length ? (
              <div className="inspection-report__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>检查项</th>
                      <th>目标值</th>
                      <th>实测值</th>
                      <th>偏差 / 允许值</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map(({ value: check, owner, key }) => (
                      <tr key={key}>
                        <th scope="row">
                          {checkName(check)}
                          {owner && <small>{owner}</small>}
                          {text(check.feature_id) && (
                            <small>特征 {text(check.feature_id)}</small>
                          )}
                          {check.kind === "bbox" && !text(check.axis) && (
                            <small>方向未提供</small>
                          )}
                        </th>
                        <td>{checkValue(check.expected, check)}</td>
                        <td>{checkValue(check.actual, check)}</td>
                        <td>
                          {checkDeviation(check)}
                          <small>
                            允许{" "}
                            {checkValue(check.tolerance, {
                              ...check,
                              kind: check.kind === "valid" ? "" : check.kind,
                            })}
                          </small>
                        </td>
                        <td>
                          <Status decision={checkDecision(check)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>逐项检查的目标值、实测值与允许偏差未提供。</p>
            )}
            {checks.some(({ value }) => value.kind === "circular_edge_diameter") && (
              <p className="inspection-report__note">
                圆边直径检查用于确认存在相近直径的圆边，不能单独证明孔数或全部孔特征正确。
              </p>
            )}
          </Section>
        </>
      )}

      {(operation === "assembly" || bom.length > 0) && (
        <Section title="装配零件清单" compact={compact} count={bom.length}>
          {bom.length ? (
            <div className="inspection-report__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>零件</th>
                    <th>数量</th>
                    <th>材料</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.map((item, index) => (
                    <tr key={index}>
                      <th scope="row">{text(item.name) || text(item.part_id) || MISSING}</th>
                      <td>{quantity(item.quantity, "件")}</td>
                      <td>{materialName(item.material)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>零件清单未提供，不能从网格数量推断零件数量。</p>
          )}
        </Section>
      )}

      {showPaths && (
        <Section title="移动路径检查" compact={compact && pathDecision !== "fail"}>
          <div className="inspection-report__path-heading">
            {noMovement ? (
              <strong>无移动路径需检查</strong>
            ) : (
              <Status
                decision={pathDecision}
                labels={[
                  "采样路径已通过",
                  "路径未通过",
                  path.checked === false ? "路径未检查" : "路径总判定未提供",
                ]}
              />
            )}
            <span>
              已检查 {checkedSteps.length} 条 · 未检查{" "}
              {missingMoving.length + steps.filter((step) => step.checked !== true).length} 条
              {fixed.length > 0 ? ` · ${fixed.length} 个实例保持固定` : ""}
            </span>
          </div>
          {text(path.reason) && <p>{reasonText(path.reason)}</p>}
          <dl className="inspection-report__metrics inspection-report__metrics--small">
            <Metric label="每条路径采样点">{quantity(path.samples_per_path, "个")}</Metric>
            <Metric label="允许交叠体积">{quantity(path.volume_tolerance_mm3, "mm³")}</Metric>
          </dl>
          {(steps.length > 0 || uncheckedMoving.length > 0) && (
            <div className="inspection-report__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>移动部件</th>
                    <th>检查状态</th>
                    <th>结果 / 说明</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step, index) => (
                    <tr key={`step-${index}`}>
                      <th scope="row">
                        {instanceName(step.instance_id)}
                        <small>顺序 {format(step.sequence)}</small>
                      </th>
                      <td>
                        {step.checked === true
                          ? `已检查 · ${quantity(step.samples, "个采样点")}`
                          : step.checked === false
                            ? "未检查"
                            : "未提供"}
                      </td>
                      <td>
                        {step.checked === true ? (
                          <Status
                            decision={
                              rows(step.collisions).length ? "fail" : flag(step.passed)
                            }
                          />
                        ) : (
                          MISSING
                        )}
                        {rows(step.collisions)
                          .slice(0, 2)
                          .map((collision, i) => (
                            <small key={i}>
                              移动至 {percentage(collision.progress)} 时与{" "}
                              {instanceName(collision.other)} 交叠{" "}
                              {quantity(collision.volume_mm3, "mm³")}
                            </small>
                          ))}
                        {step.checked === true &&
                          step.passed === false &&
                          !rows(step.collisions).length && <small>具体失败原因未提供</small>}
                      </td>
                    </tr>
                  ))}
                  {uncheckedMoving
                    .filter((item) => !steps.some((step) => step.instance_id === item.id))
                    .map((item, index) => (
                      <tr key={`missing-${index}`}>
                        <th scope="row">{instanceName(item.id)}</th>
                        <td>未检查</td>
                        <td>已给出移动方向，但没有对应路径检查记录。</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {initialInterferences.length > 0 && (
            <p className="inspection-report__failure">
              初始位置已有 {initialInterferences.length}{" "}
              组干涉，具体部件与交叠体积见上方待处理项。
            </p>
          )}
          <p className="inspection-report__note">
            范围：给定顺序下的离散采样；连续运动与实际拆卸条件未验证。
          </p>
        </Section>
      )}

      {compare && (
        <>
          <dl className="inspection-report__metrics">
            <Metric label="投影边缘吻合程度" note="投影中的边缘，有多少能在原图找到对应。">
              {percentage(metrics.precision)}
            </Metric>
            <Metric label="原图边缘覆盖程度" note="原图中的边缘，有多少被投影覆盖。">
              {percentage(metrics.recall)}
            </Metric>
            <Metric label="缺失边缘">
              {quantity(metrics.missing_pixels, "像素")}
              <small>{percentage(metrics.missing_fraction)}</small>
            </Metric>
            <Metric label="额外边缘">
              {quantity(metrics.extra_pixels, "像素")}
              <small>{percentage(metrics.extra_fraction)}</small>
            </Metric>
            <Metric label="平均轮廓偏差">
              {quantity(metrics.symmetric_mean_distance_mm, "mm")}
            </Metric>
            <Metric label="95% 轮廓偏差">{quantity(metrics.p95_distance_mm, "mm")}</Metric>
          </dl>
          <Section title="比较阈值与输入条件" compact={compact}>
            <dl className="inspection-report__metrics">
              <Metric label="两项边缘指标最低要求">
                {percentage(verification.minimum_match_fraction)}
              </Metric>
              <Metric label="轮廓匹配容差">{quantity(metrics.tolerance_mm, "mm")}</Metric>
              <Metric label="最大轮廓偏差">{quantity(metrics.max_distance_mm, "mm")}</Metric>
              <Metric label="原图标尺">
                {quantity(registration.source_px_per_mm, "像素/mm")}
              </Metric>
              <Metric label="投影标尺">
                {quantity(registration.projection_px_per_mm, "像素/mm")}
              </Metric>
              <Metric label="归一化参考长度">
                {quantity(metrics.normalization_length_mm, "mm")}
              </Metric>
            </dl>
            <p>
              投影吻合与原图覆盖必须同时达到最低要求。像素差异表示轮廓边缘差异，不是实体面积或零件数量。
            </p>
            <p className="inspection-report__note">
              需使用已裁切的对应视图、已知标尺与一致的轮廓规则；不包含整页自动配准、自动去标注或三维结构唯一性验证。
            </p>
          </Section>
        </>
      )}
      {!compare &&
        operation !== "import" &&
        !checks.some(({ value }) => value.kind === "circular_edge_diameter") && (
          <p className="inspection-report__note inspection-report__scope">
            范围：几何与已列检查条件。
          </p>
        )}
    </section>
  );
}

export default InspectionReport;
