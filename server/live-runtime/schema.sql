
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
  ON budget_requests(task_id) WHERE state IN ('reserved','dispatched','unknown');
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
    (SELECT 1 FROM budget_requests WHERE task_id = NEW.task_id AND state IN ('reserved','dispatched','unknown'));
  SELECT RAISE(ABORT, 'BUDGET_TASK_LIMIT') WHERE NEW.reserved_micros +
    COALESCE((SELECT SUM(CASE WHEN state = 'settled' THEN actual_micros
      WHEN state IN ('reserved','dispatched','unknown') THEN reserved_micros ELSE 0 END)
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
    (SELECT 1 FROM budget_requests WHERE task_id = NEW.id AND state IN ('reserved','dispatched','unknown'));
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

CREATE TABLE IF NOT EXISTS trial_documents (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL, created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trial_documents_owner ON trial_documents(owner_id,created_ms);
CREATE TRIGGER IF NOT EXISTS trial_upload_limit BEFORE INSERT ON trial_documents BEGIN
 SELECT RAISE(ABORT,'TRIAL_UPLOAD_LIMIT') WHERE
  (SELECT COUNT(*) FROM trial_documents WHERE owner_id=NEW.owner_id AND created_ms>NEW.created_ms-86400000)>=10;
 SELECT RAISE(ABORT,'TRIAL_STORAGE_LIMIT') WHERE
  NEW.bytes+COALESCE((SELECT SUM(bytes) FROM trial_documents),0)>536870912;
END;
CREATE TABLE IF NOT EXISTS trial_tasks (
 id TEXT PRIMARY KEY REFERENCES budget_tasks(id), owner_id TEXT NOT NULL, mode TEXT NOT NULL,
 prompt TEXT NOT NULL, document_id TEXT REFERENCES trial_documents(id), pages_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
 title TEXT NOT NULL, created_ms INTEGER NOT NULL, created_day TEXT NOT NULL,
 started_ms INTEGER, completed_ms INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0,
 runner_id TEXT, lease_hash TEXT, lease_expires_ms INTEGER, result_json TEXT, error TEXT, model_json TEXT
);
CREATE INDEX IF NOT EXISTS trial_tasks_owner ON trial_tasks(owner_id,created_ms);
-- Local loopback mode has no public visitor daily task quota. Replacing this
-- admission trigger does not reset tasks, requests, or accumulated spend.
DROP TRIGGER IF EXISTS trial_task_admission;
CREATE TRIGGER trial_task_admission BEFORE INSERT ON trial_tasks BEGIN
 INSERT INTO budget_tasks(id,budget_micros,created_ms) VALUES(NEW.id,500000,NEW.created_ms);
END;
CREATE TABLE IF NOT EXISTS trial_runners (
 id TEXT PRIMARY KEY, status TEXT NOT NULL, last_seen_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trial_events (
 task_id TEXT NOT NULL REFERENCES trial_tasks(id), sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
 PRIMARY KEY(task_id,sequence)
);
CREATE TABLE IF NOT EXISTS trial_artifacts (
 task_id TEXT NOT NULL REFERENCES trial_tasks(id), name TEXT NOT NULL, mime TEXT NOT NULL,
 bytes INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, PRIMARY KEY(task_id,name)
);
CREATE TRIGGER IF NOT EXISTS trial_artifact_limit BEFORE INSERT ON trial_artifacts BEGIN
 SELECT RAISE(ABORT,'TRIAL_ARTIFACT_LIMIT') WHERE
  (SELECT COUNT(*) FROM trial_artifacts WHERE task_id=NEW.task_id)>=96 OR
  NEW.bytes+COALESCE((SELECT SUM(bytes) FROM trial_artifacts WHERE task_id=NEW.task_id),0)>104857600;
 SELECT RAISE(ABORT,'TRIAL_STORAGE_LIMIT') WHERE
  NEW.bytes+COALESCE((SELECT SUM(bytes) FROM trial_artifacts),0)>1073741824;
END;
CREATE TABLE IF NOT EXISTS trial_model_calls (
 request_id TEXT PRIMARY KEY REFERENCES budget_requests(id), task_id TEXT NOT NULL REFERENCES trial_tasks(id),
 created_ms INTEGER NOT NULL, response_key TEXT, error_code TEXT,
 cached_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0
);
