/**
 * D1/SQLite budget ledger. Currency is integer microUSD ($1 = 1,000,000).
 * Only trusted server code may call the mutation functions below.
 *
 * Public trial policy: $10 total, $0.50 per task, one active task. Unknown
 * provider costs freeze the task reservation until a confirmed reconciliation.
 * Never retry a paid POST based only on a transport timeout.
 */
export const TOTAL_LIMIT_MICROS = 10_000_000;
export const TASK_LIMIT_MICROS = 500_000;
const MICRO = 1_000_000n;
const unresolved = "'reserved','dispatched','unknown'";

// Run once as a D1 migration. The triggers, not a JS read-then-write check,
// enforce admission and request reservation even across different isolates.
export const BUDGET_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS budget_tasks (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','closing','closed')),
  budget_micros INTEGER NOT NULL CHECK(budget_micros = 500000),
  created_ms INTEGER NOT NULL,
  closed_ms INTEGER
);
CREATE TABLE IF NOT EXISTS budget_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES budget_tasks(id),
  model TEXT NOT NULL,
  price_revision TEXT NOT NULL,
  bound_source TEXT NOT NULL,
  input_token_bound INTEGER NOT NULL CHECK(input_token_bound >= 0),
  max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens > 0),
  input_micros_per_million INTEGER NOT NULL CHECK(input_micros_per_million >= 0),
  output_micros_per_million INTEGER NOT NULL CHECK(output_micros_per_million >= 0),
  fixed_micros INTEGER NOT NULL CHECK(fixed_micros >= 0),
  reserved_micros INTEGER NOT NULL CHECK(reserved_micros > 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','unknown','settled','cancelled')),
  actual_micros INTEGER CHECK(actual_micros >= 0),
  prompt_tokens INTEGER CHECK(prompt_tokens >= 0),
  completion_tokens INTEGER CHECK(completion_tokens >= 0),
  generation_id TEXT,
  cost_source TEXT,
  unknown_reason TEXT,
  created_ms INTEGER NOT NULL,
  dispatched_ms INTEGER,
  settled_ms INTEGER,
  CHECK((state = 'settled' AND actual_micros IS NOT NULL AND cost_source IS NOT NULL) OR
        (state <> 'settled' AND actual_micros IS NULL))
);
CREATE INDEX IF NOT EXISTS budget_requests_task ON budget_requests(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS budget_requests_one_unresolved
  ON budget_requests(task_id) WHERE state IN (${unresolved});
CREATE UNIQUE INDEX IF NOT EXISTS budget_requests_generation
  ON budget_requests(generation_id) WHERE generation_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS budget_admit_task BEFORE INSERT ON budget_tasks BEGIN
  SELECT RAISE(ABORT, 'BUDGET_TASK_TRANSITION') WHERE NEW.state <> 'active';
  SELECT RAISE(ABORT, 'BUDGET_CEILING_BREACH') WHERE EXISTS
    (SELECT 1 FROM budget_requests WHERE state='settled' AND actual_micros>reserved_micros);
  SELECT RAISE(ABORT, 'BUDGET_BUSY') WHERE EXISTS
    (SELECT 1 FROM budget_tasks WHERE state <> 'closed');
  SELECT RAISE(ABORT, 'BUDGET_TOTAL_LIMIT') WHERE NEW.budget_micros +
    COALESCE((SELECT SUM(actual_micros) FROM budget_requests WHERE state = 'settled'), 0)
    > 10000000;
END;
CREATE TRIGGER IF NOT EXISTS budget_request_admission BEFORE INSERT ON budget_requests BEGIN
  SELECT RAISE(ABORT, 'BUDGET_REQUEST_TRANSITION') WHERE NEW.state <> 'reserved';
  SELECT RAISE(ABORT, 'BUDGET_CEILING_BREACH') WHERE EXISTS
    (SELECT 1 FROM budget_requests WHERE state='settled' AND actual_micros>reserved_micros);
  SELECT RAISE(ABORT, 'BUDGET_TASK_NOT_ACTIVE') WHERE NOT EXISTS
    (SELECT 1 FROM budget_tasks WHERE id = NEW.task_id AND state = 'active');
  SELECT RAISE(ABORT, 'BUDGET_PENDING_REQUEST') WHERE EXISTS
    (SELECT 1 FROM budget_requests WHERE task_id = NEW.task_id AND state IN (${unresolved}));
  SELECT RAISE(ABORT, 'BUDGET_TASK_LIMIT') WHERE NEW.reserved_micros +
    COALESCE((SELECT SUM(CASE WHEN state = 'settled' THEN actual_micros
      WHEN state IN (${unresolved}) THEN reserved_micros ELSE 0 END)
      FROM budget_requests WHERE task_id = NEW.task_id), 0) >
    (SELECT budget_micros FROM budget_tasks WHERE id = NEW.task_id);
END;
CREATE TRIGGER IF NOT EXISTS budget_task_immutable BEFORE UPDATE ON budget_tasks BEGIN
  SELECT RAISE(ABORT, 'BUDGET_IMMUTABLE') WHERE NEW.id <> OLD.id OR
    NEW.budget_micros <> OLD.budget_micros OR NEW.created_ms <> OLD.created_ms;
  SELECT RAISE(ABORT, 'BUDGET_TASK_TRANSITION') WHERE
    (OLD.state = 'closed' AND NEW.state <> 'closed') OR
    (OLD.state = 'closing' AND NEW.state = 'active');
  SELECT RAISE(ABORT, 'BUDGET_UNRESOLVED') WHERE NEW.state = 'closed' AND EXISTS
    (SELECT 1 FROM budget_requests WHERE task_id = NEW.id AND state IN (${unresolved}));
END;
CREATE TRIGGER IF NOT EXISTS budget_request_immutable BEFORE UPDATE ON budget_requests BEGIN
  SELECT RAISE(ABORT, 'BUDGET_IMMUTABLE') WHERE
    NEW.id <> OLD.id OR NEW.task_id <> OLD.task_id OR NEW.model <> OLD.model OR
    NEW.price_revision <> OLD.price_revision OR NEW.bound_source <> OLD.bound_source OR
    NEW.input_token_bound <> OLD.input_token_bound OR NEW.max_output_tokens <> OLD.max_output_tokens OR
    NEW.input_micros_per_million <> OLD.input_micros_per_million OR
    NEW.output_micros_per_million <> OLD.output_micros_per_million OR
    NEW.fixed_micros <> OLD.fixed_micros OR NEW.reserved_micros <> OLD.reserved_micros;
  SELECT RAISE(ABORT, 'BUDGET_REQUEST_TRANSITION') WHERE NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('dispatched','cancelled')) OR
    (OLD.state = 'dispatched' AND NEW.state IN ('unknown','settled')) OR
    (OLD.state = 'unknown' AND NEW.state IN ('unknown','settled'))
  );
END;
CREATE TRIGGER IF NOT EXISTS budget_no_task_delete BEFORE DELETE ON budget_tasks BEGIN
  SELECT RAISE(ABORT, 'BUDGET_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS budget_no_request_delete BEFORE DELETE ON budget_requests BEGIN
  SELECT RAISE(ABORT, 'BUDGET_APPEND_ONLY');
END;
`;

export class BudgetError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BudgetError'; this.code = code; }
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new BudgetError('BUDGET_INVALID_INPUT', `${name} must be a safe integer >= ${min}`);
  return value;
}
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:/-]{1,180}$/.test(value)) throw new BudgetError('BUDGET_INVALID_INPUT', `Invalid ${name}`);
  return value;
}
async function execute(promise) {
  try { return await promise; }
  catch (error) {
    const code = String(error?.message ?? error).match(/BUDGET_[A-Z_]+/)?.[0];
    if (code) throw new BudgetError(code);
    throw error;
  }
}
const now = () => Date.now();

/** Round provider USD cost UP; null/missing is unknown, never an assumed zero. */
export function usdToMicros(cost) {
  if (cost === null || cost === undefined || typeof cost === 'boolean') throw new BudgetError('BUDGET_COST_UNKNOWN');
  const value = String(cost);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) throw new BudgetError('BUDGET_INVALID_COST');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) throw new BudgetError('BUDGET_INVALID_COST');
  const fractional = match[2] ?? '';
  const numerator = BigInt(match[1] + fractional);
  const power = 6 + exponent - fractional.length;
  const result = power >= 0 ? numerator * 10n ** BigInt(power) :
    (numerator + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetError('BUDGET_INVALID_COST');
  return Number(result);
}

/**
 * Prices are microUSD per million tokens. Use a pinned provider and an upper
 * price ceiling that includes all chargeable tokens (including reasoning).
 * Byte counts are not a proven multimodal token bound. Use the provider's
 * tokenizer/documented bound, or reserve the full model context window.
 * Disable search/plugins or add every possible fixed charge to fixedMicros.
 */
export function requestCeiling({ inputTokenBound, maxOutputTokens, inputMicrosPerMillion, outputMicrosPerMillion, fixedMicros = 0 }) {
  const input = BigInt(integer(inputTokenBound, 'inputTokenBound'));
  const output = BigInt(integer(maxOutputTokens, 'maxOutputTokens', 1));
  const inRate = BigInt(integer(inputMicrosPerMillion, 'inputMicrosPerMillion'));
  const outRate = BigInt(integer(outputMicrosPerMillion, 'outputMicrosPerMillion'));
  const fixed = BigInt(integer(fixedMicros, 'fixedMicros'));
  const ceiling = (input * inRate + output * outRate + MICRO - 1n) / MICRO + fixed;
  if (ceiling <= 0n || ceiling > BigInt(Number.MAX_SAFE_INTEGER)) throw new BudgetError('BUDGET_INVALID_CEILING');
  return Number(ceiling);
}

export async function admitTask(db, { taskId, createdMs = now() }) {
  identifier(taskId, 'taskId'); integer(createdMs, 'createdMs');
  await execute(db.prepare(`INSERT INTO budget_tasks (id,budget_micros,created_ms)
    SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM budget_tasks WHERE id = ?)`)
    .bind(taskId, TASK_LIMIT_MICROS, createdMs, taskId).run());
  return getTaskBudget(db, taskId);
}

export async function reserveRequest(db, options) {
  const { taskId, requestId, model, priceRevision, boundSource, inputTokenBound,
    maxOutputTokens, inputMicrosPerMillion, outputMicrosPerMillion, fixedMicros = 0,
    createdMs = now() } = options;
  [taskId, requestId, model, priceRevision].forEach((value) => identifier(value, 'request identifier'));
  if (!['provider_tokenizer', 'model_context_limit', 'documented_upper_bound'].includes(boundSource))
    throw new BudgetError('BUDGET_UNVERIFIED_TOKEN_BOUND');
  integer(createdMs, 'createdMs');
  const reservedMicros = requestCeiling(options);
  await execute(db.prepare(`INSERT INTO budget_requests
    (id,task_id,model,price_revision,bound_source,input_token_bound,max_output_tokens,
     input_micros_per_million,output_micros_per_million,fixed_micros,reserved_micros,created_ms)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM budget_requests WHERE id = ?)`)
    .bind(requestId, taskId, model, priceRevision, boundSource, inputTokenBound, maxOutputTokens,
      inputMicrosPerMillion, outputMicrosPerMillion, fixedMicros, reservedMicros, createdMs, requestId).run());
  const record = await db.prepare('SELECT * FROM budget_requests WHERE id = ?').bind(requestId).first();
  const expected = [taskId, model, priceRevision, boundSource, inputTokenBound, maxOutputTokens, inputMicrosPerMillion, outputMicrosPerMillion, fixedMicros, reservedMicros];
  const actual = [record.task_id, record.model, record.price_revision, record.bound_source, record.input_token_bound, record.max_output_tokens, record.input_micros_per_million, record.output_micros_per_million, record.fixed_micros, record.reserved_micros];
  if (actual.some((v, i) => v !== expected[i])) throw new BudgetError('BUDGET_IDEMPOTENCY_CONFLICT');
  return record;
}

/** Must succeed immediately BEFORE the only paid fetch. A retry cannot dispatch again. */
export async function markDispatched(db, requestId, dispatchedMs = now()) {
  identifier(requestId, 'requestId'); integer(dispatchedMs, 'dispatchedMs');
  const result = await execute(db.prepare(`UPDATE budget_requests SET state='dispatched',dispatched_ms=?
    WHERE id=? AND state='reserved'`).bind(dispatchedMs, requestId).run());
  if (result.meta?.changes !== 1) throw new BudgetError('BUDGET_ALREADY_DISPATCHED');
}

export async function markUnknown(db, requestId, { generationId = null, reason = 'provider_cost_missing' } = {}) {
  identifier(requestId, 'requestId'); identifier(reason, 'reason');
  if (generationId !== null) identifier(generationId, 'generationId');
  await execute(db.prepare(`UPDATE budget_requests SET state='unknown',unknown_reason=?,generation_id=COALESCE(generation_id,?)
    WHERE id=? AND state IN ('dispatched','unknown')`).bind(reason, generationId, requestId).run());
}

/** Safe only before markDispatched; a network error does NOT authorize cancellation. */
export async function cancelUnsentRequest(db, requestId) {
  identifier(requestId, 'requestId');
  const result = await execute(db.prepare(`UPDATE budget_requests SET state='cancelled'
    WHERE id=? AND state='reserved'`).bind(requestId).run());
  if (result.meta?.changes !== 1) throw new BudgetError('BUDGET_CANNOT_CANCEL_SENT');
}

/** Provider cost must be from a server-side OpenRouter response or generation lookup. */
export async function settleRequest(db, requestId, { cost, source, generationId = null, promptTokens = null, completionTokens = null, settledMs = now() }) {
  identifier(requestId, 'requestId');
  if (!['openrouter.usage', 'openrouter.generation'].includes(source)) throw new BudgetError('BUDGET_UNVERIFIED_COST');
  if (generationId !== null) identifier(generationId, 'generationId');
  for (const [name, value] of Object.entries({ promptTokens, completionTokens, settledMs })) if (value !== null) integer(value, name);
  const actualMicros = usdToMicros(cost);
  await execute(db.batch([
    db.prepare(`UPDATE budget_requests SET state='settled',actual_micros=?,cost_source=?,
      generation_id=COALESCE(generation_id,?),prompt_tokens=?,completion_tokens=?,settled_ms=?,unknown_reason=NULL
      WHERE id=? AND state IN ('dispatched','unknown')
      AND (generation_id IS NULL OR ? IS NULL OR generation_id=?)`)
      .bind(actualMicros, source, generationId, promptTokens, completionTokens, settledMs, requestId, generationId, generationId),
    db.prepare(`UPDATE budget_tasks SET state='closed',closed_ms=? WHERE state='closing'
      AND id=(SELECT task_id FROM budget_requests WHERE id=?)
      AND NOT EXISTS (SELECT 1 FROM budget_requests r WHERE r.task_id=budget_tasks.id AND r.state IN (${unresolved}))`)
      .bind(settledMs, requestId),
  ]));
  const record = await db.prepare('SELECT * FROM budget_requests WHERE id = ?').bind(requestId).first();
  if (record && record.generation_id !== null && generationId !== null && record.generation_id !== generationId)
    throw new BudgetError('BUDGET_IDEMPOTENCY_CONFLICT');
  if (!record || record.state !== 'settled') throw new BudgetError('BUDGET_NOT_DISPATCHED');
  if (record.actual_micros !== actualMicros || (generationId !== null && record.generation_id !== generationId))
    throw new BudgetError('BUDGET_IDEMPOTENCY_CONFLICT');
  // A provider price/bound contract failure must still be honestly accounted.
  return { ...record, exceededReservation: record.actual_micros > record.reserved_micros };
}

export async function closeTask(db, taskId, closedMs = now()) {
  identifier(taskId, 'taskId'); integer(closedMs, 'closedMs');
  await execute(db.prepare(`UPDATE budget_tasks SET state=CASE WHEN EXISTS
    (SELECT 1 FROM budget_requests WHERE task_id=? AND state IN (${unresolved}))
    THEN 'closing' ELSE 'closed' END, closed_ms=CASE WHEN EXISTS
    (SELECT 1 FROM budget_requests WHERE task_id=? AND state IN (${unresolved}))
    THEN NULL ELSE ? END WHERE id=? AND state <> 'closed'`)
    .bind(taskId, taskId, closedMs, taskId).run());
  return getTaskBudget(db, taskId);
}

export async function getTaskBudget(db, taskId) {
  identifier(taskId, 'taskId');
  return db.prepare(`SELECT t.id,t.state,t.budget_micros,t.created_ms,t.closed_ms,
    COALESCE(SUM(CASE WHEN r.state='settled' THEN r.actual_micros ELSE 0 END),0) AS spent_micros,
    COALESCE(SUM(CASE WHEN r.state IN (${unresolved}) THEN r.reserved_micros ELSE 0 END),0) AS request_reserved_micros,
    COALESCE(SUM(CASE WHEN r.state IN ('dispatched','unknown') THEN 1 ELSE 0 END),0) AS unknown_requests
    FROM budget_tasks t LEFT JOIN budget_requests r ON r.task_id=t.id WHERE t.id=? GROUP BY t.id`)
    .bind(taskId).first();
}

/** No user text, credentials, or prompts are stored or returned by this ledger. */
export async function getBudgetSummary(db) {
  const totals = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state='settled' THEN actual_micros ELSE 0 END),0) AS spent_micros,
    COALESCE(SUM(CASE WHEN state IN ('dispatched','unknown') THEN reserved_micros ELSE 0 END),0) AS unknown_reserved_micros,
    COALESCE(SUM(CASE WHEN state='settled' AND actual_micros>reserved_micros THEN 1 ELSE 0 END),0) AS ceiling_breaches,
    COALESCE(SUM(CASE WHEN state='settled' THEN prompt_tokens ELSE 0 END),0) AS prompt_tokens,
    COALESCE(SUM(CASE WHEN state='settled' THEN completion_tokens ELSE 0 END),0) AS completion_tokens,
    COUNT(CASE WHEN state='settled' AND (prompt_tokens IS NULL OR completion_tokens IS NULL) THEN 1 END) AS unknown_token_requests,
    COUNT(CASE WHEN state IN ('dispatched','unknown','settled') THEN 1 END) AS attempted_requests,
    COUNT(CASE WHEN state='settled' THEN 1 END) AS settled_requests
    FROM budget_requests`).first();
  const active = await db.prepare(`SELECT COUNT(*) AS active_tasks, COALESCE(SUM(budget_micros),0) AS active_budget_micros,
    COALESCE((SELECT SUM(r.actual_micros) FROM budget_requests r JOIN budget_tasks t ON t.id=r.task_id
      WHERE r.state='settled' AND t.state<>'closed'),0) AS active_spent_micros
    FROM budget_tasks WHERE state<>'closed'`).first();
  const held = active.active_budget_micros - active.active_spent_micros;
  return { total_limit_micros: TOTAL_LIMIT_MICROS, task_limit_micros: TASK_LIMIT_MICROS, ...totals,
    active_tasks: active.active_tasks, reserved_micros: Math.max(0, held),
    available_micros: Math.max(0, TOTAL_LIMIT_MICROS - totals.spent_micros - Math.max(0, held)) };
}
