/** Resource teardown must never take down the surrounding application. */
export function cleanupSafely(...actions: Array<(() => void) | undefined>) {
  for (const action of actions) {
    try {
      action?.();
    } catch {
      // Continue releasing other resources even after a driver/disposal error.
    }
  }
}

export const STATIC_MODEL_FALLBACK = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#eef0ec"/><g fill="none" stroke="#809d8e" stroke-width="2"><path d="m240 56 72 42v83l-72 42-72-42V98zM168 98l72 42 72-42M240 140v83"/><path d="M176 247h128" stroke="#4e6659"/></g><text x="240" y="277" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#46594d">静态占位 · 三维预览不可用</text><text x="240" y="300" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#5b6e60">可打开详情查看资料或下载模型</text></svg>',
)}`;

export type AssemblyInstance = {
  id: string;
  part_id?: string;
  sequence: number;
  explode: [number, number, number];
};

export function readAssemblyPlan(value: unknown) {
  const empty = {
    instances: [] as AssemblyInstance[],
    steps: [] as string[],
    pathPassed: null as boolean | null,
  };
  if (!value || typeof value !== "object") return empty;
  const manifest = value as Record<string, any>;
  if (manifest.operation !== "assembly" || !Array.isArray(manifest.instances)) return empty;
  const instances = manifest.instances;
  if (
    !instances.length ||
    instances.some(
      (item: any) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        !Number.isFinite(item.sequence) ||
        !Array.isArray(item.explode) ||
        item.explode.length !== 3 ||
        !item.explode.every(Number.isFinite),
    )
  )
    return empty;
  const ids = new Set<string>(instances.map((item: AssemblyInstance) => item.id));
  if (ids.size !== instances.length) return empty;
  if (manifest.instance_count !== undefined && manifest.instance_count !== instances.length)
    return empty;
  const report = manifest.path_check;
  const reportSteps = report?.steps;
  const validRows =
    Array.isArray(reportSteps) &&
    reportSteps.every(
      (step: any) => step && ids.has(step.instance_id) && typeof step.checked === "boolean",
    );
  const checked = validRows ? reportSteps.filter((step: any) => step.checked) : [];
  const checkedIds = new Set<string>(checked.map((step: any) => step.instance_id));
  const movingIds = instances
    .filter((item: AssemblyInstance) => item.explode.some((n: number) => n !== 0))
    .map((item: AssemblyInstance) => item.id);
  const validReport =
    validRows &&
    checkedIds.size === checked.length &&
    movingIds.every((id: string) => checkedIds.has(id));
  // Retain the backend's checked order; never silently reorder the checked movement plan.
  const steps: string[] = validReport
    ? reportSteps.filter((step: any) => step.checked).map((step: any) => step.instance_id)
    : [...instances]
        .sort((a, b) => a.sequence - b.sequence)
        .filter((item) => item.explode.some((n: number) => n !== 0))
        .map((item) => item.id);
  const summary = manifest.verification?.path_check_passed;
  const validSummary = summary === undefined || typeof summary === "boolean";
  const contradictory =
    typeof summary === "boolean" &&
    typeof report?.passed === "boolean" &&
    summary !== report.passed;
  const failedStep =
    validReport &&
    reportSteps.some(
      (step: any) =>
        step.checked &&
        (step.passed === false ||
          (Array.isArray(step.collisions) && step.collisions.length > 0)),
    );
  const initialCollision =
    Array.isArray(report?.initial_interferences) && report.initial_interferences.length > 0;
  const pathPassed: boolean | null =
    contradictory || failedStep || initialCollision
      ? false
      : validReport &&
          validSummary &&
          steps.length > 0 &&
          checked.every((step: any) => typeof step.passed === "boolean") &&
          typeof report?.passed === "boolean"
        ? report.passed
        : null;
  return { instances: instances as AssemblyInstance[], steps, pathPassed };
}
