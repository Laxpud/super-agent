-- V0 实表结构取自 d1ce691；只保留测试涉及的表及业务依赖，不使用 V1 的 schema 常量。

CREATE TABLE IF NOT EXISTS managed_task (
  task_id TEXT PRIMARY KEY,
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  approved_text TEXT NOT NULL,
  FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE IF NOT EXISTS managed_session_binding (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES managed_task (task_id),
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  UNIQUE (task_id, execution_epoch)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_assistant_bot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bot_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE IF NOT EXISTS studio_assistant_binding (
  session_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES studio_assistant_bot (bot_id),
  UNIQUE (session_id, bot_id)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_draft_task (
  seq INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  assistant_bot_id TEXT NOT NULL,
  assistant_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_request_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  worker_bot_id TEXT NOT NULL UNIQUE,
  worker_session_id TEXT NOT NULL UNIQUE,
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  result_text TEXT,
  result_message_id TEXT,
  result_event_seq INTEGER CHECK (result_event_seq BETWEEN 0 AND 9007199254740991),
  result_turn INTEGER CHECK (result_turn BETWEEN 1 AND 9007199254740991),
  failure TEXT,
  FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
  UNIQUE (assistant_session_id, source_request_id),
  CHECK (assistant_session_id <> worker_session_id),
  CHECK ((state = 'completed' AND result_text IS NOT NULL AND result_message_id IS NOT NULL
    AND result_event_seq IS NOT NULL AND result_turn IS NOT NULL AND failure IS NULL)
    OR (state <> 'completed' AND result_text IS NULL AND result_message_id IS NULL
      AND result_event_seq IS NULL AND result_turn IS NULL AND (failure IS NULL) = (state = 'running')))
) STRICT;

CREATE TABLE IF NOT EXISTS studio_leader_bot (
  bot_id TEXT NOT NULL PRIMARY KEY
) STRICT;

CREATE TABLE IF NOT EXISTS studio_project (
  project_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  origin_task_id TEXT UNIQUE REFERENCES studio_draft_task (task_id),
  management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (project_id, management_epoch) REFERENCES studio_project_binding (project_id, management_epoch)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE IF NOT EXISTS studio_project_binding (
  leader_session_id TEXT NOT NULL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES studio_project (project_id),
  leader_bot_id TEXT NOT NULL REFERENCES studio_leader_bot (bot_id),
  management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
  command_id TEXT NOT NULL UNIQUE,
  bound_at TEXT NOT NULL,
  UNIQUE (project_id, management_epoch)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_project_work (
  work_id TEXT NOT NULL PRIMARY KEY,
  leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
  source_message_id TEXT NOT NULL,
  source_request_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  UNIQUE (leader_session_id, source_request_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS studio_project_binding_dispatch_origin
  ON studio_project_binding (project_id, management_epoch, leader_session_id);

CREATE TABLE IF NOT EXISTS studio_project_dispatch (
  work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  project_id TEXT NOT NULL,
  leader_session_id TEXT NOT NULL,
  management_epoch INTEGER NOT NULL,
  worker_session_id TEXT NOT NULL UNIQUE,
  worker_bot_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed', 'interrupted', 'released')),
  result_json TEXT,
  failure TEXT,
  PRIMARY KEY (work_id, execution_epoch),
  FOREIGN KEY (project_id, management_epoch, leader_session_id)
    REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
  CHECK (leader_session_id <> worker_session_id),
  CHECK ((state = 'completed' AND result_json IS NOT NULL AND failure IS NULL)
    OR (state IN ('reserved', 'running') AND result_json IS NULL AND failure IS NULL)
    OR (state IN ('failed', 'interrupted', 'released') AND result_json IS NULL AND failure IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_once
  ON studio_project_dispatch (work_id) WHERE state <> 'released';

CREATE TABLE IF NOT EXISTS studio_memory_revision (
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
    AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('active', 'forgotten')),
  operation TEXT NOT NULL CHECK (operation IN ('remember', 'correct', 'restrict', 'forget')),
  project_id TEXT REFERENCES studio_project (project_id),
  text TEXT,
  source_session_id TEXT NOT NULL REFERENCES studio_assistant_binding (session_id),
  command_id TEXT NOT NULL UNIQUE,
  source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
  at TEXT NOT NULL,
  PRIMARY KEY (key, revision),
  UNIQUE (source_session_id, source_event_seq),
  CHECK ((revision = 1) = (operation = 'remember')),
  CHECK ((state = 'forgotten' AND operation = 'forget' AND text IS NULL)
    OR (state = 'active' AND operation <> 'forget' AND text IS NOT NULL
      AND length(text) BETWEEN 1 AND 2000 AND instr(text, char(0)) = 0))
) STRICT;

CREATE TABLE IF NOT EXISTS studio_memory_head (
  key TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  project_id TEXT REFERENCES studio_project (project_id),
  FOREIGN KEY (key, revision) REFERENCES studio_memory_revision (key, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_memory_citation (
  citation_id TEXT NOT NULL PRIMARY KEY,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  project_id TEXT REFERENCES studio_project (project_id),
  source_session_id TEXT NOT NULL REFERENCES studio_assistant_binding (session_id),
  command_id TEXT NOT NULL UNIQUE,
  source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
  at TEXT NOT NULL,
  FOREIGN KEY (key, revision) REFERENCES studio_memory_revision (key, revision),
  UNIQUE (source_session_id, source_event_seq)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_draft_preference (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_draft_task (task_id),
  citation_id TEXT NOT NULL REFERENCES studio_memory_citation (citation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_project_fact (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
    AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  leader_session_id TEXT NOT NULL,
  management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
  command_id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  work_id TEXT NOT NULL,
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  worker_session_id TEXT NOT NULL,
  worker_bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
  event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 0 AND 9007199254740991),
  quote_offset INTEGER NOT NULL CHECK (quote_offset BETWEEN 0 AND 9007199254740991),
  quote_length INTEGER NOT NULL CHECK (quote_length BETWEEN 1 AND 1200),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (project_id, key, revision),
  FOREIGN KEY (project_id, management_epoch, leader_session_id)
    REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
  FOREIGN KEY (work_id, execution_epoch) REFERENCES studio_project_dispatch (work_id, execution_epoch)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_project_work_fact (
  work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
  turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (project_id, key, revision) REFERENCES studio_project_fact (project_id, key, revision)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_result_origin
  ON studio_project_dispatch (work_id, execution_epoch, project_id, worker_session_id, worker_bot_id);

CREATE TABLE IF NOT EXISTS studio_project_work_result_use (
  work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
  project_id TEXT NOT NULL REFERENCES studio_project (project_id),
  leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
  command_id TEXT NOT NULL UNIQUE,
  source_work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
  worker_session_id TEXT NOT NULL,
  worker_bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(message_id) > 0),
  turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
  event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 0 AND 9007199254740991),
  quote_offset INTEGER NOT NULL CHECK (quote_offset BETWEEN 0 AND 9007199254740991),
  quote_length INTEGER NOT NULL CHECK (quote_length BETWEEN 1 AND 1000
    AND quote_offset + quote_length <= 9007199254740991),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (source_work_id, execution_epoch, project_id, worker_session_id, worker_bot_id)
    REFERENCES studio_project_dispatch (work_id, execution_epoch, project_id, worker_session_id, worker_bot_id),
  CHECK (work_id <> source_work_id)
) STRICT;

CREATE TABLE IF NOT EXISTS studio_study (
  task_id TEXT PRIMARY KEY NOT NULL,
  assistant_bot_id TEXT NOT NULL,
  assistant_session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_request_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  instruction TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  failure TEXT,
  FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
  UNIQUE (assistant_session_id, source_request_id),
  UNIQUE (assistant_session_id, source_message_id),
  UNIQUE (assistant_session_id, tool_call_id),
  CHECK ((failure IS NULL) = (state IN ('running', 'completed')))
) STRICT;

CREATE TABLE IF NOT EXISTS studio_study_step (
  task_id TEXT PRIMARY KEY NOT NULL,
  study_task_id TEXT NOT NULL REFERENCES studio_study (task_id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 4),
  kind TEXT NOT NULL CHECK (kind IN ('investigation', 'synthesis')),
  excerpt TEXT,
  worker_bot_id TEXT NOT NULL UNIQUE,
  worker_session_id TEXT NOT NULL UNIQUE,
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch = 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'reserved', 'running', 'completed', 'failed', 'interrupted')),
  input_text TEXT,
  result_json TEXT,
  failure TEXT,
  UNIQUE (study_task_id, ordinal),
  CHECK ((excerpt IS NOT NULL) = (kind = 'investigation')),
  CHECK (state <> 'pending' OR input_text IS NULL),
  CHECK (state NOT IN ('reserved', 'running', 'completed') OR input_text IS NOT NULL),
  CHECK ((result_json IS NOT NULL) = (state = 'completed')),
  CHECK ((failure IS NOT NULL) = (state IN ('failed', 'interrupted')))
) STRICT;

CREATE TABLE IF NOT EXISTS studio_advisor_bot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bot_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE IF NOT EXISTS studio_advice (
  advice_id TEXT PRIMARY KEY NOT NULL,
  advisor_bot_id TEXT NOT NULL REFERENCES studio_advisor_bot (bot_id),
  advisor_session_id TEXT NOT NULL UNIQUE,
  execution_epoch INTEGER NOT NULL CHECK (execution_epoch = 1),
  requester_session_id TEXT NOT NULL,
  requester_bot_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('assistant', 'leader')),
  source_message_id TEXT NOT NULL,
  source_request_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  request_text TEXT NOT NULL,
  question TEXT NOT NULL,
  evidence_quote TEXT,
  work_id TEXT REFERENCES studio_project_work (work_id),
  project_id TEXT,
  management_epoch INTEGER CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  input_text TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed', 'interrupted')),
  result_json TEXT,
  failure TEXT,
  UNIQUE (requester_session_id, source_message_id),
  UNIQUE (requester_session_id, source_request_id),
  UNIQUE (requester_session_id, tool_call_id),
  FOREIGN KEY (project_id, management_epoch, requester_session_id)
    REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
  CHECK (requester_session_id <> advisor_session_id),
  CHECK ((role = 'assistant' AND project_id IS NULL AND management_epoch IS NULL AND work_id IS NULL)
    OR (role = 'leader' AND project_id IS NOT NULL AND management_epoch IS NOT NULL)),
  CHECK ((result_json IS NOT NULL) = (state = 'completed')),
  CHECK ((failure IS NOT NULL) = (state IN ('failed', 'interrupted')))
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision > 0),
  assistant TEXT NOT NULL, leader TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_message (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'leader')),
  channel TEXT NOT NULL CHECK (channel IN ('gui', 'feishu', 'studio')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  topic_id TEXT REFERENCES agent_studio_message(id),
  reply_to TEXT REFERENCES agent_studio_message(id),
  quote_id TEXT REFERENCES agent_studio_message(id),
  quote_text TEXT,
  request_id TEXT,
  status TEXT CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
  error TEXT,
  run_session_id TEXT,
  source_session_id TEXT,
  source_event_seq INTEGER,
  artifacts TEXT,
  feishu_scope TEXT,
  feishu_id TEXT,
  feishu_thread_id TEXT,
  feishu_generation INTEGER,
  UNIQUE (source_session_id, source_event_seq),
  UNIQUE (feishu_scope, feishu_id)
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_session (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_pending (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'question', 'blocked')),
  conversation_id TEXT NOT NULL,
  topic_id TEXT,
  message_id TEXT,
  task_id TEXT,
  requester TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  options TEXT NOT NULL,
  accepts_text INTEGER NOT NULL CHECK (accepts_text IN (0, 1)),
  mobile TEXT NOT NULL CHECK (mobile IN ('card', 'topic', 'unsupported')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
  created_at INTEGER NOT NULL,
  answer TEXT,
  answered_by TEXT CHECK (answered_by IN ('gui', 'feishu'))
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_feishu_binding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scope TEXT,
  generation INTEGER NOT NULL,
  cutover INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_feishu_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'pending', 'pending-update')),
  message_id TEXT UNIQUE REFERENCES agent_studio_message(id),
  pending_id TEXT REFERENCES agent_studio_pending(id),
  parent_message_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'sent', 'unconfirmed')),
  remote_id TEXT,
  UNIQUE (pending_id, kind),
  CHECK ((kind = 'message') = (message_id IS NOT NULL) AND (kind = 'message') = (pending_id IS NULL)),
  CHECK ((state = 'sent') = (remote_id IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS agent_studio_revision (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES agent_studio_message(id),
  message_id TEXT NOT NULL UNIQUE,
  worker_session_id TEXT NOT NULL UNIQUE,
  work_type TEXT NOT NULL CHECK (work_type IN ('draft', 'study', 'work')),
  work_id TEXT NOT NULL,
  origin_request_id TEXT NOT NULL REFERENCES agent_studio_message(id),
  origin_message_id TEXT NOT NULL,
  based_on_revision_id TEXT REFERENCES agent_studio_revision(id),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  created_at INTEGER NOT NULL,
  result_text TEXT,
  result_event_seq INTEGER CHECK (result_event_seq BETWEEN 0 AND 9007199254740991),
  CHECK (owner_session_id <> worker_session_id AND origin_request_id <> request_id),
  CHECK ((state = 'completed') = (result_text IS NOT NULL) AND (state = 'completed') = (result_event_seq IS NOT NULL))
) STRICT;
